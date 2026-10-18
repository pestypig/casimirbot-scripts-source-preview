import fs from "node:fs";
import path from "node:path";
import { runPickPlaceBenchmark } from "../server/services/robotics-benchmark";

const outDir = path.resolve(process.cwd(), "artifacts", "robotics-benchmark");
fs.mkdirSync(outDir, { recursive: true });

const report = runPickPlaceBenchmark();
const outPath = path.join(outDir, "pick-place-report.json");
fs.writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");

console.log(`[robotics-benchmark] wrote report ${outPath}`);
console.log(JSON.stringify(report));
