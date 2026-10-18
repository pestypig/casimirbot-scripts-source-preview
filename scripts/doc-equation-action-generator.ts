import {
  DOC_EQUATION_ACTION_MANIFEST_VERSION,
  type DocEquationActionEntryV1,
  type DocEquationActionManifestV1,
} from "../shared/contracts/doc-equation-action-manifest.v1";
import {
  isDocEquationActionSourceV1,
  type DocEquationActionSourceEntryV1,
  type DocEquationActionSourceV1,
} from "../shared/contracts/doc-equation-action-source.v1";

export const DOC_EQUATION_MARKER_PREFIX = "helix-doc-equation-action/v1";

type ExtractedDocEquation = {
  equationId: string;
  sectionAnchor?: string;
  latex: string;
};

type HeadingState = {
  level: number;
  text: string;
  anchor: string;
};

const markerPattern = /^\s*<!--\s*helix-doc-equation-action\/v1\s+id=([A-Za-z0-9._:-]+)\s*-->\s*$/;

export function slugMarkdownHeading(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/^-+|-+$/g, "");
}

function normalizeDisplayMathBlock(lines: string[]): string {
  return lines
    .map((line) => line.trim())
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .replace(/\\qquad\s+/g, "\\qquad ")
    .trim();
}

function normalizeJoinedDisplayMathBlocks(blocks: string[]): string {
  if (blocks.length <= 1) return blocks[0] ?? "";
  const segments = blocks
    .map((block) => block.trim().replace(/[,.]\s*$/g, ""))
    .filter(Boolean);
  return segments.length ? `${segments.join(",\\qquad ")}.` : "";
}

function readDisplayMathBlock(lines: string[], startIndex: number): { latex: string; nextIndex: number } | null {
  for (let index = startIndex; index < lines.length; index += 1) {
    if (lines[index].trim() !== "\\[") continue;
    const blockLines: string[] = [];
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      if (lines[cursor].trim() === "\\]") {
        return {
          latex: normalizeDisplayMathBlock(blockLines),
          nextIndex: cursor + 1,
        };
      }
      blockLines.push(lines[cursor]);
    }
    return null;
  }
  return null;
}

function extractMarkedEquations(
  markdown: string,
  sourceEntries: Map<string, DocEquationActionSourceEntryV1>,
): ExtractedDocEquation[] {
  const lines = markdown.split(/\r?\n/);
  const extracted: ExtractedDocEquation[] = [];
  let currentHeading: HeadingState | null = null;

  for (let index = 0; index < lines.length; index += 1) {
    const heading = /^(#{1,6})\s+(.+?)\s*$/.exec(lines[index]);
    if (heading) {
      currentHeading = {
        level: heading[1].length,
        text: heading[2].trim(),
        anchor: slugMarkdownHeading(heading[2]),
      };
      continue;
    }

    const marker = markerPattern.exec(lines[index]);
    if (!marker) continue;
    const equationId = marker[1];
    const sourceEntry = sourceEntries.get(equationId);
    if (!sourceEntry) {
      throw new Error(`Equation marker ${equationId} has no source entry`);
    }
    const blockCount = sourceEntry.mathBlockCount ?? 1;
    const blocks: string[] = [];
    let nextIndex = index + 1;
    for (let blockIndex = 0; blockIndex < blockCount; blockIndex += 1) {
      const block = readDisplayMathBlock(lines, nextIndex);
      if (!block) {
        throw new Error(`Equation marker ${equationId} is missing display math block ${blockIndex + 1}`);
      }
      blocks.push(block.latex);
      nextIndex = block.nextIndex;
    }
    extracted.push({
      equationId,
      ...(currentHeading?.anchor ? { sectionAnchor: currentHeading.anchor } : {}),
      latex: normalizeJoinedDisplayMathBlocks(blocks),
    });
  }

  return extracted;
}

export function buildDocEquationActionManifestFromMarkdown(args: {
  markdown: string;
  source: unknown;
}): DocEquationActionManifestV1 {
  if (!isDocEquationActionSourceV1(args.source)) {
    throw new Error("Invalid doc equation action source");
  }
  const source = args.source as DocEquationActionSourceV1;
  const sourceEntries = new Map(source.entries.map((entry) => [entry.equationId, entry]));
  const extractedEntries = new Map(
    extractMarkedEquations(args.markdown, sourceEntries).map((entry) => [entry.equationId, entry]),
  );

  const entries: DocEquationActionEntryV1[] = source.entries.map((entry) => {
    const extracted = extractedEntries.get(entry.equationId);
    if (!extracted) {
      throw new Error(`Source entry ${entry.equationId} has no matching markdown marker`);
    }
    return {
      equationId: entry.equationId,
      label: entry.label,
      ...(extracted.sectionAnchor ? { sectionAnchor: extracted.sectionAnchor } : {}),
      latex: extracted.latex,
      ...(entry.aliases?.length ? { aliases: entry.aliases } : {}),
      actions: entry.actions,
      claimBoundaryNotes: entry.claimBoundaryNotes,
    };
  });

  const extraMarkers = Array.from(extractedEntries.keys()).filter((equationId) => !sourceEntries.has(equationId));
  if (extraMarkers.length > 0) {
    throw new Error(`Markdown contains equation markers missing from source: ${extraMarkers.join(", ")}`);
  }

  return {
    contractVersion: DOC_EQUATION_ACTION_MANIFEST_VERSION,
    docPath: source.docPath,
    generatedAt: source.generatedAt,
    entries,
  };
}

export function stableStringifyDocEquationActionManifest(manifest: DocEquationActionManifestV1): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}
