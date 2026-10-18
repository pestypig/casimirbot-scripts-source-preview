import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

type ToolStatus = {
  id: string;
  ok: boolean;
  detail: string;
  path: string | null;
};

type DoctorReport = {
  timestamp: string;
  os: string;
  overall: "ready" | "partial" | "blocked";
  tools: ToolStatus[];
  notes: string[];
};

const run = (cmd: string, args: string[]): { ok: boolean; stdout: string; stderr: string } => {
  const out = spawnSync(cmd, args, { encoding: "utf8" });
  return {
    ok: out.status === 0,
    stdout: (out.stdout ?? "").trim(),
    stderr: (out.stderr ?? "").trim(),
  };
};

const firstExistingPath = (paths: string[]): string | null => {
  for (const p of paths) {
    if (existsSync(p)) return p;
  }
  return null;
};

const checkNvcc = (): ToolStatus => {
  const where = run("where", ["nvcc"]);
  if (!where.ok || !where.stdout) {
    return { id: "cuda_nvcc", ok: false, detail: "nvcc not found in PATH", path: null };
  }
  const nvccPath = where.stdout.split(/\r?\n/)[0].trim();
  const ver = run("nvcc", ["--version"]);
  return {
    id: "cuda_nvcc",
    ok: ver.ok,
    detail: ver.ok ? "nvcc available" : `nvcc error: ${ver.stderr || "unknown"}`,
    path: nvccPath || null,
  };
};

const checkNvidiaSmi = (): ToolStatus => {
  const smi = run("nvidia-smi", []);
  return {
    id: "nvidia_smi",
    ok: smi.ok,
    detail: smi.ok ? "GPU driver reachable" : "nvidia-smi unavailable",
    path: null,
  };
};

const checkRenderDoc = (): ToolStatus => {
  const p = firstExistingPath([
    "C:\\Program Files\\RenderDoc\\qrenderdoc.exe",
    "C:\\Program Files (x86)\\RenderDoc\\qrenderdoc.exe",
  ]);
  return {
    id: "renderdoc",
    ok: !!p,
    detail: p ? "installed" : "not installed",
    path: p,
  };
};

const checkParaView = (): ToolStatus => {
  const p = firstExistingPath([
    "C:\\Program Files\\ParaView 6.0.1\\bin\\paraview.exe",
    "C:\\Program Files\\ParaView 6.0\\bin\\paraview.exe",
  ]);
  return {
    id: "paraview",
    ok: !!p,
    detail: p ? "installed" : "not installed",
    path: p,
  };
};

const checkNsightGraphics = (): ToolStatus => {
  const staticCandidates = [
    "C:\\Program Files\\NVIDIA Corporation\\Nsight Graphics 2026.1.0\\host\\windows-desktop-nomad-x64\\ngfx-ui.exe",
    "C:\\Program Files\\NVIDIA Corporation\\Nsight Graphics 2026.1.0\\host\\windows-desktop-nomad-x64\\ngfx.exe",
    "C:\\Program Files\\NVIDIA Corporation\\Nsight Graphics 2025.1\\host\\windows-desktop-nomad-x64\\Nvda.Graphics.Interception.exe",
    "C:\\Program Files\\NVIDIA Corporation\\Nsight Graphics 2024.4\\host\\windows-desktop-nomad-x64\\Nvda.Graphics.Interception.exe",
    "C:\\Program Files\\NVIDIA Corporation\\Nsight Graphics\\host\\windows-desktop-nomad-x64\\Nvda.Graphics.Interception.exe",
  ];
  const roots = [
    "C:\\Program Files\\NVIDIA Corporation",
    "C:\\Program Files (x86)\\NVIDIA Corporation",
  ];

  const dynamicCandidates: string[] = [];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    const dirs = readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory() && d.name.startsWith("Nsight Graphics"))
      .map((d) => d.name);
    for (const dir of dirs) {
      dynamicCandidates.push(
        join(root, dir, "host", "windows-desktop-nomad-x64", "ngfx-ui.exe"),
        join(root, dir, "host", "windows-desktop-nomad-x64", "ngfx.exe"),
        join(root, dir, "host", "windows-desktop-nomad-x64", "Nvda.Graphics.Interception.exe"),
      );
    }
  }

  const p = firstExistingPath([...staticCandidates, ...dynamicCandidates]);
  return {
    id: "nsight_graphics",
    ok: !!p,
    detail: p ? "installed" : "not installed (manual NVIDIA installer may be required)",
    path: p,
  };
};

const checkVs = (): ToolStatus => {
  const vswhere = "C:\\Program Files (x86)\\Microsoft Visual Studio\\Installer\\vswhere.exe";
  if (!existsSync(vswhere)) {
    return { id: "visual_studio", ok: false, detail: "vswhere missing", path: null };
  }
  const out = run(vswhere, [
    "-latest",
    "-products",
    "*",
    "-requires",
    "Microsoft.VisualStudio.Component.VC.Tools.x86.x64",
    "-property",
    "installationPath",
  ]);
  const installPath = out.stdout.split(/\r?\n/)[0]?.trim() || "";
  return {
    id: "visual_studio",
    ok: !!installPath,
    detail: installPath ? "MSVC toolchain available" : "MSVC toolchain not found",
    path: installPath || null,
  };
};

const checkOwl = (): ToolStatus => {
  const repoPath = firstExistingPath(["C:\\owl-src", "tools\\optix-owl"]);
  const dllPath = firstExistingPath(["C:\\owl-build\\Release\\owl.dll"]);
  if (repoPath && dllPath) {
    return {
      id: "owl_optix_wrapper",
      ok: true,
      detail: "OWL source + build artifact present",
      path: `${repoPath} | ${dllPath}`,
    };
  }
  if (repoPath) {
    return {
      id: "owl_optix_wrapper",
      ok: false,
      detail: "OWL source present, build artifact missing",
      path: repoPath,
    };
  }
  return {
    id: "owl_optix_wrapper",
    ok: false,
    detail: "OWL not cloned",
    path: null,
  };
};

const checkInstallerLock = (): ToolStatus => {
  const proc = run("powershell", [
    "-NoProfile",
    "-Command",
    "(Get-CimInstance Win32_Process | Where-Object {$_.Name -eq 'msiexec.exe'} | Select-Object -ExpandProperty CommandLine) -join \"`n\"",
  ]);
  const commandLines = proc.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const hasActiveTransaction = commandLines.some((line) =>
    /\/(i|x|package)\b|\.msi\b/i.test(line),
  );
  return {
    id: "windows_installer_lock",
    ok: !hasActiveTransaction,
    detail: hasActiveTransaction
      ? "active MSI transaction detected; installs may fail with 1618"
      : "no active MSI transaction detected",
    path: null,
  };
};

const toolStatuses: ToolStatus[] = [
  checkNvcc(),
  checkNvidiaSmi(),
  checkVs(),
  checkRenderDoc(),
  checkParaView(),
  checkNsightGraphics(),
  checkOwl(),
  checkInstallerLock(),
];

const requiredIds = new Set([
  "cuda_nvcc",
  "nvidia_smi",
  "visual_studio",
  "renderdoc",
  "paraview",
  "nsight_graphics",
  "owl_optix_wrapper",
]);

const required = toolStatuses.filter((tool) => requiredIds.has(tool.id));
const requiredOkCount = required.filter((tool) => tool.ok).length;
const overall: DoctorReport["overall"] =
  requiredOkCount === required.length
    ? "ready"
    : requiredOkCount >= Math.floor(required.length / 2)
      ? "partial"
      : "blocked";

const notes: string[] = [];
if (!toolStatuses.find((x) => x.id === "paraview")?.ok) {
  notes.push("ParaView missing: install with winget or direct Kitware installer for XDMF/HDF5 inspection.");
}
if (!toolStatuses.find((x) => x.id === "nsight_graphics")?.ok) {
  notes.push("Nsight Graphics missing: install from NVIDIA Developer portal (winget package not available here).");
}
if (!toolStatuses.find((x) => x.id === "windows_installer_lock")?.ok) {
  notes.push("Windows Installer transaction active: close pending MSI install/uninstall jobs or reboot.");
}

const report: DoctorReport = {
  timestamp: new Date().toISOString(),
  os: process.platform,
  overall,
  tools: toolStatuses,
  notes,
};

console.log(JSON.stringify(report, null, 2));

if (overall === "blocked") {
  process.exitCode = 2;
} else if (overall === "partial") {
  process.exitCode = 1;
}
