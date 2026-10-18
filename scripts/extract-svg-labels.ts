// scripts/extract-svg-labels.ts
import { readFileSync, writeFileSync } from "fs";
import { XMLParser } from "fast-xml-parser";

type Node = any;

function parseTransform(t?: string) {
  // supports translate(x,y) and scale(sx[,sy])
  const out = { tx: 0, ty: 0, sx: 1, sy: 1 };
  if (!t) return out;
  const parts = t.match(/(translate|scale)\s*\(([^)]+)\)/g) || [];
  for (const p of parts) {
    const [, kind, argsStr] = p.match(/(translate|scale)\s*\(([^)]+)\)/)!;
    const nums = argsStr.split(/[,\s]+/).map(Number);
    if (kind === "translate") {
      out.tx += nums[0] || 0;
      out.ty += nums[1] || 0;
    } else if (kind === "scale") {
      const sx = nums[0] ?? 1; const sy = nums[1] ?? sx;
      out.sx *= sx; out.sy *= sy;
    }
  }
  return out;
}

function apply(x: number, y: number, tr: {tx:number;ty:number;sx:number;sy:number}) {
  return { x: x*tr.sx + tr.tx, y: y*tr.sy + tr.ty };
}

function walk(node: Node, parentTr = {tx:0,ty:0,sx:1,sy:1}, labels: any[] = []) {
  if (!node || typeof node !== "object") return labels;
  const tr = parseTransform(node["@_transform"]);
  const acc = {
    tx: parentTr.tx + tr.tx,
    ty: parentTr.ty + tr.ty,
    sx: parentTr.sx * tr.sx,
    sy: parentTr.sy * tr.sy,
  };

  if (node.text) {
    const t = node.text;
    const x = Number(t["@_x"] ?? 0);
    const y = Number(t["@_y"] ?? 0);
    const { x: X, y: Y } = apply(x, y, acc);
    const content = (typeof t["#text"] === "string" ? t["#text"] : (Array.isArray(t.tspan) ? t.tspan.map((s:any)=>s["#text"]).join(" ") : "")).trim();
    if (content) {
      labels.push({
        text: content,
        x: X,
        y: Y,
        fontSize: Number(t["@_font-size"] ?? 0) * acc.sy || undefined,
        fill: t["@_fill"] || undefined,
      });
    }
  }

  // Some SVGs nest multiple <text> children or <g> groups
  for (const key of Object.keys(node)) {
    if (key === "text" || key === "@_transform" || key === "#text") continue;
    const child = node[key];
    if (Array.isArray(child)) child.forEach(c=>walk(c, acc, labels));
    else if (typeof child === "object") walk(child, acc, labels);
  }
  return labels;
}

function main() {
  const svgPath = process.argv[2] || "public/map_2020_6000pc.svg";
  const outPath = process.argv[3] || "public/galaxy_labels.json";
  const xml = readFileSync(svgPath, "utf8");
  const parser = new XMLParser({ ignoreAttributes: false, preserveOrder: false, attributeNamePrefix: "@_" });
  const root = parser.parse(xml);

  // The file's root key is usually 'svg'
  const svgNode = root.svg ?? root;
  const labels = walk(svgNode, {tx:0,ty:0,sx:1,sy:1}, []);
  // filter out tiny or blank labels
  const clean = labels.filter((l:any)=>l.text && l.text.length>=2);

  writeFileSync(outPath, JSON.stringify({
    meta: { source: svgPath, count: clean.length, note: "coords in SVG native pixels" },
    labels: clean
  }, null, 2));
  console.log(`Wrote ${clean.length} labels -> ${outPath}`);
}

main();