import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "../..");
const PRIMARY_MANIFEST = path.join(
  ROOT,
  "configs/research/casimir-numerical/advection-diffusion-lanyon-adapter-build.v1.json",
);
const INDEPENDENT_MANIFEST = path.join(
  ROOT,
  "configs/research/casimir-numerical/advection-diffusion-analytic-reference-build.v1.json",
);
const HARNESS_MANIFEST = path.join(
  ROOT,
  "configs/research/casimir-numerical/advection-diffusion-harness-runtime.v1.json",
);

type BuildManifest = {
  driver?: { logical_path: string; sha256: string };
  source?: { logical_path: string; sha256: string };
  upstream?: { logical_path: string; sha256: string };
  toolchain: { compiler_sha256: string; flags: string[] };
  output: { logical_name: string; sha256: string };
};
type HarnessManifest = {
  source: { logical_path: string; sha256: string };
  runtime: { executable_sha256: string };
};

const sha256 = (bytes: Uint8Array | string): string =>
  createHash("sha256").update(bytes).digest("hex");
const readJson = async <T>(filePath: string): Promise<T> =>
  JSON.parse(await fs.readFile(filePath, "utf8")) as T;
const argument = (name: string): string | null => {
  const index = process.argv.indexOf(name);
  return index >= 0 && index + 1 < process.argv.length
    ? process.argv[index + 1]
    : null;
};

async function requireExactFile(
  filePath: string,
  expectedSha256: string,
  label: string,
): Promise<string> {
  if (!path.isAbsolute(filePath)) throw new Error(`${label}_path_not_absolute`);
  const absolutePath = path.resolve(filePath);
  const stat = await fs.lstat(absolutePath);
  if (!stat.isFile() || stat.isSymbolicLink())
    throw new Error(`${label}_not_regular_file`);
  const realPath = await fs.realpath(absolutePath);
  const same =
    process.platform === "win32"
      ? realPath.toLowerCase() === absolutePath.toLowerCase()
      : realPath === absolutePath;
  if (!same) throw new Error(`${label}_path_alias_forbidden`);
  if (sha256(await fs.readFile(absolutePath)) !== expectedSha256)
    throw new Error(`${label}_hash_mismatch`);
  return absolutePath;
}

const run = (
  command: string,
  args: string[],
  cwd: string,
  shell = false,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<{ stdout: string; stderr: string }> =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      shell,
      windowsHide: true,
      env: { ...environment },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
    child.once("error", reject);
    child.once("close", (code) => {
      const result = {
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      };
      if (code === 0) resolve(result);
      else
        reject(
          new Error(
            `build_process_failed:${code}:${result.stderr || result.stdout}`,
          ),
        );
    });
  });

async function main(): Promise<void> {
  if (process.platform !== "win32")
    throw new Error("fixture_build_requires_win32_msvc");
  const lanyonRootArgument = argument("--lanyon-root");
  const outputRootArgument = argument("--output-root");
  if (!lanyonRootArgument || !outputRootArgument) {
    throw new Error(
      "usage: --lanyon-root <absolute pinned snapshot> --output-root <new absolute directory>",
    );
  }
  const lanyonRoot = path.resolve(lanyonRootArgument);
  const outputRoot = path.resolve(outputRootArgument);
  if (!path.isAbsolute(lanyonRootArgument))
    throw new Error("lanyon_root_path_not_absolute");
  if (!path.isAbsolute(outputRootArgument))
    throw new Error("output_root_path_not_absolute");
  try {
    await fs.lstat(outputRoot);
    throw new Error("output_root_must_not_exist");
  } catch (error) {
    if (!(
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ))
      throw error;
  }

  const primary = await readJson<BuildManifest>(PRIMARY_MANIFEST);
  const independent = await readJson<BuildManifest>(INDEPENDENT_MANIFEST);
  const harness = await readJson<HarnessManifest>(HARNESS_MANIFEST);
  if (!primary.driver || !primary.upstream || !independent.source)
    throw new Error("fixture_build_manifest_shape_invalid");
  const primarySource = await requireExactFile(
    path.join(ROOT, primary.driver.logical_path),
    primary.driver.sha256,
    "primary_driver",
  );
  const upstreamSource = await requireExactFile(
    path.join(lanyonRoot, primary.upstream.logical_path),
    primary.upstream.sha256,
    "lanyon_upstream_source",
  );
  const independentSource = await requireExactFile(
    path.join(ROOT, independent.source.logical_path),
    independent.source.sha256,
    "independent_source",
  );
  const harnessSource = await requireExactFile(
    path.join(ROOT, harness.source.logical_path),
    harness.source.sha256,
    "harness_source",
  );
  await requireExactFile(
    process.execPath,
    harness.runtime.executable_sha256,
    "node_runtime",
  );

  const vcvars =
    process.env.CASIMIR_MSVC_VCVARS64?.trim() ||
    "C:\\Program Files\\Microsoft Visual Studio\\2022\\Community\\VC\\Auxiliary\\Build\\vcvars64.bat";
  await fs.access(vcvars);
  await fs.mkdir(outputRoot);
  const primaryExecutable = path.join(outputRoot, primary.output.logical_name);
  const independentExecutable = path.join(
    outputRoot,
    independent.output.logical_name,
  );
  const quote = (value: string): string => `"${value.replaceAll('"', '""')}"`;
  const primaryObject = path.join(outputRoot, "lanyon-adapter.obj");
  const independentObject = path.join(outputRoot, "analytic-reference.obj");
  const flags = primary.toolchain.flags.join(" ");
  if (
    JSON.stringify(primary.toolchain.flags) !==
    JSON.stringify(independent.toolchain.flags)
  ) {
    throw new Error("compiler_flag_manifest_mismatch");
  }
  const command = [
    `call ${quote(vcvars)} >nul`,
    `cl ${flags} /Fo:${quote(primaryObject)} /Fe:${quote(primaryExecutable)} ${quote(primarySource)} /I${quote(path.dirname(upstreamSource))}`,
    `cl ${flags} /Fo:${quote(independentObject)} /Fe:${quote(independentExecutable)} ${quote(independentSource)}`,
  ].join(" && ");
  const transcript = await run(command, [], ROOT, true);
  await requireExactFile(
    primaryExecutable,
    primary.output.sha256,
    "primary_executable",
  );
  await requireExactFile(
    independentExecutable,
    independent.output.sha256,
    "independent_executable",
  );
  const snapshotRoot = path.join(outputRoot, "source-snapshot");
  await fs.mkdir(snapshotRoot);
  const snapshotFiles = [
    [primarySource, "advection-diffusion-lanyon-adapter.c"],
    [PRIMARY_MANIFEST, "advection-diffusion-lanyon-adapter-build.v1.json"],
    [independentSource, "advection-diffusion-analytic-reference.c"],
    [
      INDEPENDENT_MANIFEST,
      "advection-diffusion-analytic-reference-build.v1.json",
    ],
    [harnessSource, "advection-diffusion-harness.mjs"],
    [HARNESS_MANIFEST, "advection-diffusion-harness-runtime.v1.json"],
  ] as const;
  await Promise.all(
    snapshotFiles.map(([source, target]) =>
      fs.copyFile(source, path.join(snapshotRoot, target)),
    ),
  );
  await run("git", ["init", "--quiet"], snapshotRoot);
  await run(
    "git",
    [
      "-c",
      "core.autocrlf=false",
      "add",
      "--",
      ...snapshotFiles.map(([, target]) => target),
    ],
    snapshotRoot,
  );
  const gitEnvironment = {
    ...process.env,
    GIT_AUTHOR_NAME: "Casimir Numerical Fixture",
    GIT_AUTHOR_EMAIL: "casimir-numerical@invalid.local",
    GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z",
    GIT_COMMITTER_NAME: "Casimir Numerical Fixture",
    GIT_COMMITTER_EMAIL: "casimir-numerical@invalid.local",
    GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z",
  };
  await run(
    "git",
    ["commit", "--quiet", "-m", "Casimir numerical fixture source snapshot"],
    snapshotRoot,
    false,
    gitEnvironment,
  );
  const snapshotCommit = (
    await run("git", ["rev-parse", "HEAD"], snapshotRoot)
  ).stdout.trim();
  const snapshotTree = (
    await run("git", ["rev-parse", "HEAD^{tree}"], snapshotRoot)
  ).stdout.trim();
  const snapshotManifestSha256 = sha256(
    (
      await Promise.all(
        snapshotFiles.map(async ([, target]) => ({
          path: target,
          sha256: sha256(await fs.readFile(path.join(snapshotRoot, target))),
        })),
      )
    )
      .sort((left, right) => left.path.localeCompare(right.path))
      .map((entry) => `${entry.path}\t${entry.sha256}\n`)
      .join(""),
  );
  const receipt = {
    schema: "casimir_numerical_fixture_build_receipt/v1",
    generatedAt: new Date().toISOString(),
    lanyonRoot,
    upstreamSource,
    primaryManifestSha256: sha256(await fs.readFile(PRIMARY_MANIFEST)),
    independentManifestSha256: sha256(await fs.readFile(INDEPENDENT_MANIFEST)),
    harnessManifestSha256: sha256(await fs.readFile(HARNESS_MANIFEST)),
    harnessSource,
    harnessExecutable: process.execPath,
    primaryExecutable,
    independentExecutable,
    sourceSnapshot: {
      repositoryPath: snapshotRoot,
      commitSha: snapshotCommit,
      treeSha: snapshotTree,
      selectedSourceManifestSha256: snapshotManifestSha256,
    },
    transcriptSha256: sha256(
      JSON.stringify({
        stdout: transcript.stdout,
        stderr: transcript.stderr,
      }),
    ),
    authority: {
      buildBytesReproduced: true,
      numericalComparisonChecked: false,
      validatesNumericalImplementation: false,
      validatesTheory: false,
      terminalEligible: false,
    },
  };
  await fs.writeFile(
    path.join(outputRoot, "build-receipt.json"),
    JSON.stringify(receipt, null, 2),
    { encoding: "utf8", flag: "wx" },
  );
  process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exitCode = 1;
});
