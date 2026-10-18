import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { writeLocalSnapshotAtomically } from "../server/db/client";

// Read-only with respect to the supplied snapshot. Never print its contents.
// Use the production writer, not a synthetic replacement, and remove only
// this benchmark's exact generated files. No server is launched or contacted.
async function main() {
  const source = process.argv[2];
  if (!source) throw new Error("Supply one existing local snapshot path.");
  const snapshot = JSON.parse(await fs.promises.readFile(path.resolve(source), "utf8"));
  if (snapshot.schema !== "helix.local_pg_mem_snapshot.v1" ||
      !snapshot.tables || typeof snapshot.tables !== "object" ||
      !Object.values(snapshot.tables).every(Array.isArray)) {
    throw new Error("Unsupported snapshot shape.");
  }
  const sourceBytes = (await fs.promises.stat(path.resolve(source))).size;
  const space = await fs.promises.statfs(os.tmpdir());
  if (space.bavail * space.bsize < sourceBytes * 3 + 128 * 1024 * 1024) {
    throw new Error("Insufficient free space for isolated atomic-write benchmark.");
  }
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "casimir-snapshot-benchmark-"));
  const destination = path.join(directory, "snapshot.json");
  const temporary = `${destination}.${process.pid}.tmp`;
  try {
    const durations: number[] = [];
    for (let index = 0; index < 3; index++) {
      const start = performance.now();
      await writeLocalSnapshotAtomically(destination, snapshot);
      durations.push(performance.now() - start);
    }
    const restored = JSON.parse(await fs.promises.readFile(destination, "utf8"));
    // Structural roundtrip comparison stays local; no profile data is printed.
    const roundtrip = JSON.stringify(restored) === JSON.stringify(snapshot);
    if (!roundtrip) throw new Error("Snapshot roundtrip mismatch.");
    console.log(JSON.stringify({
      schema: "casimir.local_snapshot_writer_benchmark.v1",
      source_bytes: sourceBytes,
      written_bytes: (await fs.promises.stat(destination)).size,
      atomic_write_ms: durations,
      roundtrip_equal: roundtrip,
      includes_database_collection: false,
      live_capacity_proof: false,
    }));
  } finally {
    await fs.promises.rm(temporary, { force: true });
    await fs.promises.rm(destination, { force: true });
    await fs.promises.rmdir(directory);
  }
}

main().catch(error => {
  // Do not emit parser errors that could quote profile content.
  console.error(error instanceof Error && /^(Supply|Unsupported|Insufficient|Snapshot roundtrip)/.test(error.message)
    ? error.message : "Isolated snapshot benchmark failed; no snapshot content printed.");
  process.exitCode = 1;
});
