import { buildGrEvolveBrick } from "../server/gr-evolve-brick";

type PerfCase = {
  label: string;
  dims: [number, number, number];
  steps: number;
  dt_s: number;
};

const cases: PerfCase[] = [
  { label: "48^3", dims: [48, 48, 48], steps: 4, dt_s: 1e-6 },
  { label: "64^3", dims: [64, 64, 64], steps: 4, dt_s: 1e-6 },
];

const formatCount = (value: number) => Math.round(value).toLocaleString("en-US");

for (const perfCase of cases) {
  const brick = buildGrEvolveBrick({
    dims: perfCase.dims,
    steps: perfCase.steps,
    dt_s: perfCase.dt_s,
    includeExtra: false,
    includeMatter: true,
  });
  const perf = brick.stats.perf;
  if (!perf) {
    console.log(`${perfCase.label}: perf stats missing`);
    continue;
  }
  console.log(
    [
      `${perfCase.label} dims=${perfCase.dims.join("x")} steps=${perfCase.steps}`,
      `total_ms=${perf.totalMs.toFixed(1)}`,
      `evolve_ms=${perf.evolveMs.toFixed(1)}`,
      `brick_ms=${perf.brickMs.toFixed(1)}`,
      `ms_per_step=${perf.msPerStep.toFixed(2)}`,
      `voxels=${formatCount(perf.voxels)}`,
      `channels=${formatCount(perf.channelCount)}`,
      `bytes_est=${formatCount(perf.bytesEstimate)}`,
    ].join(" | "),
  );
}
