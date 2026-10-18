/** Hash a local, caller-authored NAV-EQ plan draft with the v1 canonical order. */
const { readFileSync } = require("node:fs");
const { createHash } = require("node:crypto");

const path = process.argv[2];
if (!path) throw new Error("Expected a local JSON plan-draft path");
const plan = JSON.parse(readFileSync(path, "utf8"));
const canonical = (value) => Array.isArray(value)
  ? value.map(canonical)
  : value && typeof value === "object"
    ? Object.fromEntries(Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, canonical(nested)]))
    : value;
process.stdout.write(`sha256:${createHash("sha256")
  .update(JSON.stringify(canonical(plan)))
  .digest("hex")}`);
