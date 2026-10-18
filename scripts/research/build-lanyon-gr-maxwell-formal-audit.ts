import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import {
  buildCasimirFormalArtifactGenerationLineageAuditV1,
  computeCasimirFormalArtifactGenerationLineagePathSetSha256V1,
  validateCasimirFormalArtifactGenerationLineageAuditIntegrityV1,
} from "../../shared/contracts/casimir-formal-artifact-generation-lineage-audit.v1";
import {
  CASIMIR_FORMAL_ARTIFACT_FAMILY_AUDIT_ARTIFACT_ID,
  CASIMIR_FORMAL_ARTIFACT_FAMILY_AUDIT_SCHEMA_VERSION,
  CASIMIR_FORMAL_DENIED_PROMOTIONS,
  buildCasimirFormalArtifactFamilyAuditV1,
  validateCasimirFormalArtifactFamilyAuditV1,
  type CasimirFormalArtifactFamilyCaseV1,
  type CasimirFormalArtifactFamilyAuditV1,
  type CasimirFormalAuditedTheoremV1,
  type CasimirFormalClaimCeilingV1,
  type CasimirFormalPropertyKindV1,
} from "../../shared/contracts/casimir-formal-artifact-family-audit.v1";

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(import.meta.dirname, "../..");
const OUTPUT = path.join(
  ROOT,
  "configs/research/casimir-formal-theorem-audits/lanyon-gr-maxwell-b13da44.v1.json",
);
const GENERATION_LINEAGE_OUTPUT = path.join(
  ROOT,
  "configs/research/casimir-formal-generation-lineage-audits/lanyon-gr-maxwell-b13da44.v1.json",
);
const REPOSITORY_URI =
  "https://github.com/lanyonai/GeneralRelativisticMaxwell";
const PINNED_COMMIT = "b13da44d9e93e9f3c8dbdab48590fc2e08a8bff3";
const PINNED_SELECTED_TREE_SHA256 =
  "0ff049323382600bac8ef7a24d97fe07c19adad27d66634e7fb136be7a7ecb7c";

const CASES = [
  ["gr_hyperbolic_maxwell_1d", "hyperbolic_divergence_cleaning", 1],
  ["gr_hyperbolic_maxwell_2d", "hyperbolic_divergence_cleaning", 2],
  ["gr_hyperbolic_maxwell_3d", "hyperbolic_divergence_cleaning", 3],
  ["gr_maxwell_1d", "standard", 1],
  ["gr_maxwell_2d", "standard", 2],
  ["gr_maxwell_3d", "standard", 3],
] as const;

const sha256 = (value: Uint8Array | string): string =>
  createHash("sha256").update(value).digest("hex");
const arg = (name: string): string | null => {
  const index = process.argv.indexOf(name);
  return index >= 0 && index + 1 < process.argv.length
    ? process.argv[index + 1]
    : null;
};
const git = async (
  repositoryRoot: string,
  args: string[],
  encoding: BufferEncoding | null = "utf8",
): Promise<string | Buffer> => {
  const result = await execFileAsync("git", ["-C", repositoryRoot, ...args], {
    encoding,
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
  });
  return result.stdout;
};

const propertyForName = (
  theoremName: string,
): {
  propertyKind: CasimirFormalPropertyKindV1;
  claimCeiling: CasimirFormalClaimCeilingV1;
} => {
  const suffix = theoremName.replace(/^[xyz]/, "");
  const mapping: Record<
    string,
    {
      propertyKind: CasimirFormalPropertyKindV1;
      claimCeiling: CasimirFormalClaimCeilingV1;
    }
  > = {
    Hyperbolicity: {
      propertyKind: "real_typed_expression_witness",
      claimCeiling: "definition_well_typed",
    },
    WaveStability: {
      propertyKind: "declared_wave_speed_bound",
      claimCeiling: "declared_algebraic_identity",
    },
    DiffusiveFluxConsistency: {
      propertyKind: "zero_gradient_diffusive_flux",
      claimCeiling: "local_consistency_identity",
    },
    WaveConsistency: {
      propertyKind: "equal_state_wave_zero",
      claimCeiling: "local_consistency_identity",
    },
    WaveJumpCondition: {
      propertyKind: "wave_sum_state_jump_identity",
      claimCeiling: "local_consistency_identity",
    },
    LeftFluctuationsConsistent: {
      propertyKind: "equal_state_left_fluctuation_zero",
      claimCeiling: "local_consistency_identity",
    },
    RightFluctuationsConsistent: {
      propertyKind: "equal_state_right_fluctuation_zero",
      claimCeiling: "local_consistency_identity",
    },
    FluxConservative: {
      propertyKind: "conditional_flux_jump_fluctuation_identity",
      claimCeiling: "local_consistency_identity",
    },
    LeftReconstructionConsistent: {
      propertyKind: "constant_state_left_reconstruction",
      claimCeiling: "local_consistency_identity",
    },
    RightReconstructionConsistent: {
      propertyKind: "constant_state_right_reconstruction",
      claimCeiling: "local_consistency_identity",
    },
    LeftReconstructionLinearityPreservation: {
      propertyKind: "affine_left_reconstruction_identity",
      claimCeiling: "local_consistency_identity",
    },
    RightReconstructionLinearityPreservation: {
      propertyKind: "affine_right_reconstruction_identity",
      claimCeiling: "local_consistency_identity",
    },
    ReconstructionSymmetric: {
      propertyKind: "reconstruction_reversal_symmetry",
      claimCeiling: "local_consistency_identity",
    },
  };
  const classified = mapping[suffix];
  if (!classified)
    throw new Error(`unclassified_theorem_name:${theoremName}`);
  return classified;
};

const topLevelPropositionColon = (
  declaration: string,
  theoremName: string,
): number => {
  let depth = 0;
  const start = declaration.indexOf(theoremName) + theoremName.length;
  for (let index = start; index < declaration.length; index += 1) {
    const character = declaration[index];
    if (character === "(" || character === "{" || character === "[") depth += 1;
    if (character === ")" || character === "}" || character === "]") depth -= 1;
    if (character === ":" && depth === 0) return index;
  }
  throw new Error(`top_level_proposition_colon_missing:${theoremName}`);
};

const extractTheorems = (
  logicalPath: string,
  moduleName: string,
  source: string,
): CasimirFormalAuditedTheoremV1[] => {
  const theoremPattern = /^theorem\s+([A-Za-z0-9_']+)/gm;
  const matches = [...source.matchAll(theoremPattern)];
  return matches.map((match) => {
    const theoremName = match[1];
    const start = match.index;
    const proofMarker = source.indexOf(":= by", start);
    if (proofMarker < 0)
      throw new Error(`proof_marker_missing:${moduleName}.${theoremName}`);
    const declaration = source.slice(start, proofMarker + ":= by".length);
    const propositionColon = topLevelPropositionColon(declaration, theoremName);
    const proposition = declaration
      .slice(propositionColon + 1, declaration.lastIndexOf(":= by"))
      .trim();
    if (!proposition)
      throw new Error(`empty_proposition:${moduleName}.${theoremName}`);
    const startLine = source.slice(0, start).split("\n").length;
    const endLine =
      startLine + declaration.slice(0, -1).split("\n").length - 1;
    const classification = propertyForName(theoremName);
    return {
      theoremId: `${moduleName}.${theoremName}`,
      caseId: moduleName,
      moduleName,
      theoremName,
      logicalPath,
      sourceRange: { startLine, endLine },
      declarationSha256: sha256(declaration),
      propositionSourceSha256: sha256(proposition),
      ...classification,
      deniedPromotions: [...CASIMIR_FORMAL_DENIED_PROMOTIONS],
      replay: {
        status: "blocked",
        observedTheoremTypeSha256: null,
        blockers: [
          "formal_environment_unpinned",
          "import_closure_unpinned",
          "semantic_binding_missing",
          "observed_theorem_type_missing",
        ],
      },
    };
  });
};

async function main(): Promise<void> {
  const repositoryArgument = arg("--repo");
  if (!repositoryArgument || !path.isAbsolute(repositoryArgument))
    throw new Error("usage: --repo <absolute pinned GeneralRelativisticMaxwell checkout>");
  const repositoryRoot = path.resolve(repositoryArgument);
  const commit = String(await git(repositoryRoot, ["rev-parse", "HEAD"])).trim();
  if (commit !== PINNED_COMMIT)
    throw new Error(`repository_commit_mismatch:${commit}`);

  const cases: CasimirFormalArtifactFamilyCaseV1[] = [];
  const theorems: CasimirFormalAuditedTheoremV1[] = [];
  const selectedArtifacts: {
    logicalPath: string;
    sha256: string;
    sizeBytes: number;
  }[] = [];
  for (const [caseId, formulation, dimensions] of CASES) {
    const paths = {
      specification: `specifications/${caseId}.rkt`,
      formalSource: `proofs/${caseId}.lean`,
      implementationSource: `implementations/${caseId}.c`,
    };
    const [specificationBytes, formalBytes, implementationBytes] =
      await Promise.all([
        git(repositoryRoot, ["show", `HEAD:${paths.specification}`], null),
        git(repositoryRoot, ["show", `HEAD:${paths.formalSource}`], null),
        git(
          repositoryRoot,
          ["show", `HEAD:${paths.implementationSource}`],
          null,
        ),
      ]);
    if (
      !(specificationBytes instanceof Buffer) ||
      !(formalBytes instanceof Buffer) ||
      !(implementationBytes instanceof Buffer)
    ) {
      throw new Error("git_blob_read_did_not_return_bytes");
    }
    const artifacts = {
      specification: {
        logicalPath: paths.specification,
        sha256: sha256(specificationBytes),
        sizeBytes: specificationBytes.length,
      },
      formalSource: {
        logicalPath: paths.formalSource,
        sha256: sha256(formalBytes),
        sizeBytes: formalBytes.length,
      },
      implementationSource: {
        logicalPath: paths.implementationSource,
        sha256: sha256(implementationBytes),
        sizeBytes: implementationBytes.length,
      },
    };
    selectedArtifacts.push(
      artifacts.specification,
      artifacts.formalSource,
      artifacts.implementationSource,
    );
    const formalText = formalBytes.toString("utf8");
    if (formalText.includes("\r"))
      throw new Error(`non_canonical_line_endings:${paths.formalSource}`);
    const caseTheorems = extractTheorems(paths.formalSource, caseId, formalText);
    theorems.push(...caseTheorems);
    cases.push({
      caseId,
      formulation,
      dimensions,
      specification: artifacts.specification,
      formalSource: {
        ...artifacts.formalSource,
        moduleName: caseId,
        imports: ["Mathlib"],
        theoremCount: caseTheorems.length,
      },
      implementationSource: {
        ...artifacts.implementationSource,
        numericModel: "c_ieee754_binary64",
        entrypointStatus: "placeholder_noop",
        formalRefinementStatus: "unassessed",
      },
    });
  }
  const selectedTreeManifest = `${selectedArtifacts
    .sort((left, right) => left.logicalPath.localeCompare(right.logicalPath, "en"))
    .map(
      (entry) =>
        `${entry.logicalPath}\t${entry.sha256}\t${entry.sizeBytes}`,
    )
    .join("\n")}\n`;
  const selectedSourceTreeSha256 = sha256(selectedTreeManifest);
  if (selectedSourceTreeSha256 !== PINNED_SELECTED_TREE_SHA256)
    throw new Error(
      `selected_source_tree_mismatch:${selectedSourceTreeSha256}`,
    );
  if (theorems.length !== 156)
    throw new Error(`unexpected_theorem_count:${theorems.length}`);

  const withoutHash: Omit<
    CasimirFormalArtifactFamilyAuditV1,
    "artifactSha256"
  > = {
    artifactId: CASIMIR_FORMAL_ARTIFACT_FAMILY_AUDIT_ARTIFACT_ID,
    schemaVersion: CASIMIR_FORMAL_ARTIFACT_FAMILY_AUDIT_SCHEMA_VERSION,
    auditId: "casimir.lanyon.gr-maxwell.source-audit.2026-07-29",
    repository: {
      producerId: "lanyon",
      uri: REPOSITORY_URI,
      commitSha: PINNED_COMMIT,
      selectedSourceTreeSha256,
      canonicalByteSource: "git_blob",
      selectedArtifactCount: selectedArtifacts.length,
    },
    environment: {
      leanImportsObserved: ["Mathlib"],
      leanVersion: null,
      dependencyLockSha256: null,
      importClosureSha256: null,
      replayEligible: false,
    },
    cases,
    theorems,
    authority: {
      outputRole: "formal_artifact_family_source_audit",
      sourceAdmissionAuthority: true,
      formalPropositionChecked: false,
      scientificAuthority: false,
      numericalAuthority: false,
      empiricalAuthority: false,
      physicalAuthority: false,
      assistantAnswer: false,
      terminalEligible: false,
    },
  };
  const audit = await buildCasimirFormalArtifactFamilyAuditV1(withoutHash);
  const issues = await validateCasimirFormalArtifactFamilyAuditV1(audit);
  if (issues.length > 0)
    throw new Error(`generated_audit_invalid:${issues.join("|")}`);

  const repositoryPaths = String(
    await git(
      repositoryRoot,
      ["ls-tree", "-r", "-t", "--name-only", "HEAD"],
      "utf8",
    ),
  )
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .sort((left, right) => left.localeCompare(right, "en"));
  if (new Set(repositoryPaths).size !== repositoryPaths.length)
    throw new Error("repository_tree_paths_not_unique");
  const generatorCandidatePaths = repositoryPaths.filter((entry) =>
    /(generator|generate|prompt|lanyon)/i.test(entry),
  );
  if (generatorCandidatePaths.length > 0)
    throw new Error(
      `generator_candidate_paths_require_review:${generatorCandidatePaths.join(",")}`,
    );
  const pathSetSha256 =
    await computeCasimirFormalArtifactGenerationLineagePathSetSha256V1({
      repositoryUri: REPOSITORY_URI,
      commitSha: PINNED_COMMIT,
      paths: repositoryPaths,
    });
  const generationLineageAudit =
    await buildCasimirFormalArtifactGenerationLineageAuditV1({
      generatedAt: "2026-07-30T00:00:00.000Z",
      auditId:
        "casimir.lanyon.gr-maxwell.generator-lineage-audit.2026-07-30",
      sourceAuditArtifactSha256: audit.artifactSha256,
      repository: {
        producerId: "lanyon",
        uri: REPOSITORY_URI,
        commitSha: PINNED_COMMIT,
        selectedSourceTreeSha256,
        canonicalByteSource: "git_blob",
      },
      recursiveTreeInspection: {
        ref: PINNED_COMMIT,
        complete: true,
        truncated: false,
        entryCount: repositoryPaths.length,
        pathSetSha256,
        paths: repositoryPaths,
        generatorCandidatePaths,
      },
      generatorLineage: {
        status: "not_published_in_pinned_repository",
        generatorArtifactId: null,
        generatorRevisionSha256: null,
        invocationManifestSha256: null,
        generationReceiptId: null,
        generationReceiptSha256: null,
        requiredForExecutionEnrollment: true,
        blockerCode: "formal_generator_lineage_unavailable",
      },
    });
  const generationLineageIssues =
    await validateCasimirFormalArtifactGenerationLineageAuditIntegrityV1(
      generationLineageAudit,
    );
  if (generationLineageIssues.length > 0)
    throw new Error(
      `generated_generation_lineage_audit_invalid:${generationLineageIssues.join("|")}`,
    );

  await fs.mkdir(path.dirname(OUTPUT), { recursive: true });
  await fs.writeFile(OUTPUT, `${JSON.stringify(audit, null, 2)}\n`, "utf8");
  await fs.mkdir(path.dirname(GENERATION_LINEAGE_OUTPUT), {
    recursive: true,
  });
  await fs.writeFile(
    GENERATION_LINEAGE_OUTPUT,
    `${JSON.stringify(generationLineageAudit, null, 2)}\n`,
    "utf8",
  );
  process.stdout.write(
    `${JSON.stringify({
      output: path.relative(ROOT, OUTPUT).replaceAll("\\", "/"),
      artifactSha256: audit.artifactSha256,
      generationLineageOutput: path
        .relative(ROOT, GENERATION_LINEAGE_OUTPUT)
        .replaceAll("\\", "/"),
      generationLineageArtifactSha256:
        generationLineageAudit.artifactSha256,
      repositoryTreeEntryCount: repositoryPaths.length,
      selectedSourceTreeSha256,
      cases: cases.length,
      theorems: theorems.length,
    })}\n`,
  );
}

void main();
