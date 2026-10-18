import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  buildCasimirArtifactGenerationReceiptV1,
  buildCasimirArtifactGenerationRequestV1,
} from "../../shared/contracts/casimir-artifact-generation.v1";
import { buildCasimirIndependentNumericalReplayPolicyV1 } from "../../shared/contracts/casimir-independent-numerical-replay-policy.v1";
import { buildCasimirIndependentNumericalVerificationRequestV1 } from "../../shared/contracts/casimir-independent-numerical-verification.v1";
import {
  computeCasimirSpecValueSha256V1,
  validateCasimirSpecScientificClaimIrIntegrityV1,
  type CasimirSpecScientificClaimIrV1,
} from "../../shared/contracts/casimir-spec-scientific-claim-ir.v1";
import { replayCasimirIndependentNumericalRequestV1 } from "../../server/services/theory/casimir-independent-numerical-replay";

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
const CASIMIR_SPEC_FIXTURE = path.join(
  ROOT,
  "shared/contracts/__tests__/fixtures/casimir-spec/advection-diffusion.open-world.valid.v1.json",
);
const BUILD_SCRIPT = path.join(
  ROOT,
  "scripts/research/build-casimir-advection-diffusion-fixture.ts",
);

type BuildManifest = {
  lineage_id: string;
  implementation_id: string;
  driver?: { logical_path: string; sha256: string };
  source?: { logical_path: string; sha256: string };
  toolchain: { compiler_sha256: string };
  runtime_environment: {
    ucrtbase_sha256: string;
    platform_sha256: string;
  };
  output: { logical_name: string; sha256: string };
};
type HarnessManifest = {
  runtime_id: string;
  protocol: "casimir_numerical_harness_json_files/v1";
  launch_mode: "node_script";
  source: { logical_path: string; sha256: string };
  runtime: { executable_sha256: string };
};
type BuildReceipt = {
  schema: "casimir_numerical_fixture_build_receipt/v1";
  primaryManifestSha256: string;
  independentManifestSha256: string;
  harnessManifestSha256: string;
  harnessSource: string;
  harnessExecutable: string;
  primaryExecutable: string;
  independentExecutable: string;
  transcriptSha256: string;
  sourceSnapshot: {
    repositoryPath: string;
    commitSha: string;
    selectedSourceManifestSha256: string;
  };
};

const sha256 = (value: Uint8Array | string): string =>
  createHash("sha256").update(value).digest("hex");
const argument = (name: string): string | null => {
  const index = process.argv.indexOf(name);
  return index >= 0 && index + 1 < process.argv.length
    ? process.argv[index + 1]
    : null;
};
const readJson = async <T>(filePath: string): Promise<T> =>
  JSON.parse(await fs.readFile(filePath, "utf8")) as T;
const fileSize = async (filePath: string): Promise<number> =>
  Number((await fs.stat(filePath)).size);

async function requireHash(
  filePath: string,
  expectedSha256: string,
  label: string,
): Promise<void> {
  if (!path.isAbsolute(filePath)) throw new Error(`${label}_path_not_absolute`);
  const stat = await fs.lstat(filePath);
  if (!stat.isFile() || stat.isSymbolicLink())
    throw new Error(`${label}_not_regular_file`);
  if (sha256(await fs.readFile(filePath)) !== expectedSha256)
    throw new Error(`${label}_hash_mismatch`);
}

async function buildGenerationEvidence(input: {
  lane: "primary" | "independent";
  spec: CasimirSpecScientificClaimIrV1;
  claimId: string;
  propositionSha256: string;
  sourcePath: string;
  sourceSha256: string;
  buildManifestPath: string;
  buildManifestSha256: string;
  buildReceipt: BuildReceipt;
  adapterRevisionSha256: string;
}) {
  const sourcePacketSha256 = await computeCasimirSpecValueSha256V1({
    domain: "casimir-advection-diffusion-generation-source-packet/v1",
    lane: input.lane,
    sourceSha256: input.sourceSha256,
    buildManifestSha256: input.buildManifestSha256,
    snapshotCommitSha: input.buildReceipt.sourceSnapshot.commitSha,
  });
  const generationRequest = await buildCasimirArtifactGenerationRequestV1({
    generatedAt: new Date().toISOString(),
    requestId: `casimir-advection-diffusion-generation:${input.lane}`,
    casimirSpec: {
      specId: input.spec.specId,
      schemaVersion: input.spec.schemaVersion,
      semanticSha256: input.spec.semanticSha256,
      artifactSha256: input.spec.artifactSha256,
    },
    claim: {
      claimId: input.claimId,
      propositionSha256: input.propositionSha256,
    },
    sourcePacket: {
      packetId: `casimir-advection-diffusion-source:${input.lane}`,
      mediaType: "application/vnd.casimir.scientific-source+json",
      artifactSha256: sourcePacketSha256,
    },
    masterProblem: {
      schemaVersion: "theory_master_problem/v1",
      planId: `casimir-advection-diffusion-master:${input.lane}`,
      artifactSha256: await computeCasimirSpecValueSha256V1({
        domain: "casimir-advection-diffusion-master-problem/v1",
        lane: input.lane,
        claimId: input.claimId,
      }),
    },
    derivationProgram: {
      schemaVersion: "theory_derivation_program/v1",
      programId: `casimir-advection-diffusion-derivation:${input.lane}`,
      sourceMasterProblemPlanId: `casimir-advection-diffusion-master:${input.lane}`,
      artifactSha256: await computeCasimirSpecValueSha256V1({
        domain: "casimir-advection-diffusion-derivation-program/v1",
        lane: input.lane,
        claimId: input.claimId,
      }),
    },
    producerPolicy: {
      adapterContractId: `casimir-advection-diffusion-build:${input.lane}/v1`,
      adapterContractSha256: input.adapterRevisionSha256,
      allowedProducerIds: [`casimir-numerical-build:${input.lane}`],
      immutableRepositoryPinRequired: true,
      outputHashRequired: true,
      providerOutputTrusted: false,
    },
    requestedArtifacts: [
      {
        artifactId: `casimir-advection-diffusion:${input.lane}:build-manifest`,
        role: "build_manifest",
        mediaType: "application/json",
      },
      {
        artifactId: `casimir-advection-diffusion:${input.lane}:source`,
        role: "implementation_source",
        mediaType: "text/x-c",
      },
    ],
  });
  const receipt = await buildCasimirArtifactGenerationReceiptV1({
    generatedAt: new Date().toISOString(),
    receiptId: `casimir-advection-diffusion-generation-receipt:${input.lane}`,
    request: {
      schemaVersion: generationRequest.schemaVersion,
      requestId: generationRequest.requestId,
      artifactSha256: generationRequest.artifactSha256,
      casimirSpec: {
        semanticSha256: input.spec.semanticSha256,
        artifactSha256: input.spec.artifactSha256,
      },
      claimId: input.claimId,
      propositionSha256: input.propositionSha256,
      masterProblem: {
        planId: generationRequest.masterProblem.planId,
        artifactSha256: generationRequest.masterProblem.artifactSha256,
      },
      derivationProgram: {
        programId: generationRequest.derivationProgram.programId,
        artifactSha256: generationRequest.derivationProgram.artifactSha256,
      },
    },
    producer: {
      producerId: `casimir-numerical-build:${input.lane}`,
      adapterId: generationRequest.producerPolicy.adapterContractId,
      adapterRevisionSha256: input.adapterRevisionSha256,
      upstreamRepository: {
        uri: pathToFileURL(
          input.buildReceipt.sourceSnapshot.repositoryPath,
        ).toString(),
        commitSha: input.buildReceipt.sourceSnapshot.commitSha,
        sourceTreeSha256:
          input.buildReceipt.sourceSnapshot.selectedSourceManifestSha256,
      },
    },
    run: {
      status: "succeeded",
      startedAt: "2000-01-01T00:00:00.000Z",
      completedAt: new Date().toISOString(),
      transcriptSha256: input.buildReceipt.transcriptSha256,
      environmentSha256: await computeCasimirSpecValueSha256V1({
        domain: "casimir-advection-diffusion-build-environment/v1",
        adapterRevisionSha256: input.adapterRevisionSha256,
        snapshotCommitSha: input.buildReceipt.sourceSnapshot.commitSha,
      }),
    },
    artifacts: [
      {
        artifactId: `casimir-advection-diffusion:${input.lane}:build-manifest`,
        role: "build_manifest",
        mediaType: "application/json",
        logicalPath: path.basename(input.buildManifestPath),
        artifactSha256: input.buildManifestSha256,
        sizeBytes: await fileSize(input.buildManifestPath),
        derivedFromSha256s: [sourcePacketSha256],
      },
      {
        artifactId: `casimir-advection-diffusion:${input.lane}:source`,
        role: "implementation_source",
        mediaType: "text/x-c",
        logicalPath: path.basename(input.sourcePath),
        artifactSha256: input.sourceSha256,
        sizeBytes: await fileSize(input.sourcePath),
        derivedFromSha256s: [sourcePacketSha256],
      },
    ],
    blockers: [],
  });
  return { generationRequest, receipt };
}

async function main(): Promise<void> {
  const buildRootArgument = argument("--build-root");
  const evidenceRootArgument = argument("--evidence-root");
  if (!buildRootArgument || !evidenceRootArgument)
    throw new Error(
      "usage: --build-root <absolute fixture build> --evidence-root <new absolute directory>",
    );
  if (!path.isAbsolute(buildRootArgument))
    throw new Error("build_root_path_not_absolute");
  if (!path.isAbsolute(evidenceRootArgument))
    throw new Error("evidence_root_path_not_absolute");
  const buildRoot = path.resolve(buildRootArgument);
  const evidenceRoot = path.resolve(evidenceRootArgument);
  const buildReceipt = await readJson<BuildReceipt>(
    path.join(buildRoot, "build-receipt.json"),
  );
  const primaryManifest = await readJson<BuildManifest>(PRIMARY_MANIFEST);
  const independentManifest =
    await readJson<BuildManifest>(INDEPENDENT_MANIFEST);
  const harnessManifest = await readJson<HarnessManifest>(HARNESS_MANIFEST);
  if (!primaryManifest.driver || !independentManifest.source)
    throw new Error("numerical_manifest_shape_invalid");
  await Promise.all([
    requireHash(
      PRIMARY_MANIFEST,
      buildReceipt.primaryManifestSha256,
      "primary_manifest",
    ),
    requireHash(
      INDEPENDENT_MANIFEST,
      buildReceipt.independentManifestSha256,
      "independent_manifest",
    ),
    requireHash(
      HARNESS_MANIFEST,
      buildReceipt.harnessManifestSha256,
      "harness_manifest",
    ),
    requireHash(
      buildReceipt.primaryExecutable,
      primaryManifest.output.sha256,
      "primary_executable",
    ),
    requireHash(
      buildReceipt.independentExecutable,
      independentManifest.output.sha256,
      "independent_executable",
    ),
    requireHash(
      buildReceipt.harnessSource,
      harnessManifest.source.sha256,
      "harness_source",
    ),
    requireHash(
      buildReceipt.harnessExecutable,
      harnessManifest.runtime.executable_sha256,
      "harness_executable",
    ),
  ]);
  const spec =
    await readJson<CasimirSpecScientificClaimIrV1>(CASIMIR_SPEC_FIXTURE);
  const specIssues =
    await validateCasimirSpecScientificClaimIrIntegrityV1(spec);
  if (specIssues.length > 0)
    throw new Error(`casimir_spec_invalid:${specIssues.join(";")}`);
  const claim = spec.claims.find(
    (entry) => entry.claimId === "claim:advection-diffusion-equation",
  );
  if (!claim) throw new Error("advection_diffusion_claim_missing");
  const adapterRevisionSha256 = sha256(await fs.readFile(BUILD_SCRIPT));
  const primarySourcePath = path.join(
    ROOT,
    primaryManifest.driver.logical_path,
  );
  const independentSourcePath = path.join(
    ROOT,
    independentManifest.source.logical_path,
  );
  const primaryGeneration = await buildGenerationEvidence({
    lane: "primary",
    spec,
    claimId: claim.claimId,
    propositionSha256: claim.propositionSha256,
    sourcePath: primarySourcePath,
    sourceSha256: primaryManifest.driver.sha256,
    buildManifestPath: PRIMARY_MANIFEST,
    buildManifestSha256: buildReceipt.primaryManifestSha256,
    buildReceipt,
    adapterRevisionSha256,
  });
  const independentGeneration = await buildGenerationEvidence({
    lane: "independent",
    spec,
    claimId: claim.claimId,
    propositionSha256: claim.propositionSha256,
    sourcePath: independentSourcePath,
    sourceSha256: independentManifest.source.sha256,
    buildManifestPath: INDEPENDENT_MANIFEST,
    buildManifestSha256: buildReceipt.independentManifestSha256,
    buildReceipt,
    adapterRevisionSha256,
  });
  const caseInputs = {
    domain: [0, 1],
    advectionVelocity: 0.5,
    diffusivity: 0.01,
    finalTime: 0.05,
  };
  const mesh = { kind: "uniform_periodic_cell_centered", cells: [32, 64, 128] };
  const initialConditions = {
    expression: "1 + 0.25*sin(2*pi*x)",
    exact: true,
  };
  const boundaryConditions = { x: "periodic" };
  const comparisonPolicyCore = {
    policyId: "casimir-advection-diffusion-periodic-1d-comparison/v1",
    norm: "l2_relative" as const,
    tolerances: [
      {
        observableId: "solution_l2_error",
        absoluteTolerance: 0.001,
        relativeTolerance: 0.001,
      },
    ],
    minimumRefinementLevels: 3,
    minimumObservedOrder: 0.7,
    deterministicSeed: "casimir-advection-diffusion-periodic-1d-v1",
  };
  const primaryEnvironment = {
    environmentId: "msvc-lanyon-adapter-win32-x64/v1",
    toolchainSha256: primaryManifest.toolchain.compiler_sha256,
    runtimeSha256: primaryManifest.runtime_environment.ucrtbase_sha256,
    platformSha256: primaryManifest.runtime_environment.platform_sha256,
  };
  const independentEnvironment = {
    environmentId: "msvc-analytic-reference-win32-x64/v1",
    toolchainSha256: independentManifest.toolchain.compiler_sha256,
    runtimeSha256: independentManifest.runtime_environment.ucrtbase_sha256,
    platformSha256: independentManifest.runtime_environment.platform_sha256,
  };
  const request = await buildCasimirIndependentNumericalVerificationRequestV1({
    requestId: "casimir-advection-diffusion-periodic-1d-numerical/v1",
    casimirSpec: {
      specId: spec.specId,
      schemaVersion: spec.schemaVersion,
      semanticSha256: spec.semanticSha256,
      artifactSha256: spec.artifactSha256,
    },
    claim: {
      claimId: claim.claimId,
      propositionSha256: claim.propositionSha256,
    },
    primaryImplementation: {
      implementationId: primaryManifest.implementation_id,
      lineageId: primaryManifest.lineage_id,
      sourceSha256: primaryManifest.driver.sha256,
      buildManifestSha256: buildReceipt.primaryManifestSha256,
      producerReceipt: {
        schemaVersion: primaryGeneration.receipt.schemaVersion,
        receiptId: primaryGeneration.receipt.receiptId,
        artifactSha256: primaryGeneration.receipt.artifactSha256,
      },
    },
    independentImplementation: {
      implementationId: independentManifest.implementation_id,
      lineageId: independentManifest.lineage_id,
      sourceSha256: independentManifest.source.sha256,
      buildManifestSha256: buildReceipt.independentManifestSha256,
      producerReceipt: {
        schemaVersion: independentGeneration.receipt.schemaVersion,
        receiptId: independentGeneration.receipt.receiptId,
        artifactSha256: independentGeneration.receipt.artifactSha256,
      },
    },
    frozenCase: {
      caseId: "casimir-advection-diffusion-periodic-1d/v1",
      inputsSha256: await computeCasimirSpecValueSha256V1({
        domain: "casimir-advection-diffusion-case-inputs/v1",
        value: caseInputs,
      }),
      meshSha256: await computeCasimirSpecValueSha256V1({
        domain: "casimir-advection-diffusion-mesh/v1",
        value: mesh,
      }),
      initialConditionsSha256: await computeCasimirSpecValueSha256V1({
        domain: "casimir-advection-diffusion-initial-conditions/v1",
        value: initialConditions,
      }),
      boundaryConditionsSha256: await computeCasimirSpecValueSha256V1({
        domain: "casimir-advection-diffusion-boundary-conditions/v1",
        value: boundaryConditions,
      }),
      observables: [{ observableId: "solution_l2_error", unit: "1" }],
    },
    comparisonPolicy: {
      ...comparisonPolicyCore,
      artifactSha256: await computeCasimirSpecValueSha256V1({
        domain: "casimir-advection-diffusion-comparison-policy/v1",
        value: comparisonPolicyCore,
      }),
    },
    environments: {
      primary: primaryEnvironment,
      independent: independentEnvironment,
    },
    executionPolicy: {
      replayCount: 2,
      networkAllowed: false,
      arbitraryCommandAllowed: false,
      outerObservedProcessRequired: true,
    },
  });
  const replayPolicy = await buildCasimirIndependentNumericalReplayPolicyV1({
    policyId: "casimir-advection-diffusion-numerical-replay/v1",
    harness: {
      protocol: harnessManifest.protocol,
      launchMode: harnessManifest.launch_mode,
      executableSha256: harnessManifest.runtime.executable_sha256,
      sourceSha256: harnessManifest.source.sha256,
    },
    lanes: {
      primary: {
        implementationId: request.primaryImplementation.implementationId,
        lineageId: request.primaryImplementation.lineageId,
        sourceSha256: request.primaryImplementation.sourceSha256,
        buildManifestSha256: request.primaryImplementation.buildManifestSha256,
        executableSha256: primaryManifest.output.sha256,
        environment: primaryEnvironment,
      },
      independent: {
        implementationId: request.independentImplementation.implementationId,
        lineageId: request.independentImplementation.lineageId,
        sourceSha256: request.independentImplementation.sourceSha256,
        buildManifestSha256:
          request.independentImplementation.buildManifestSha256,
        executableSha256: independentManifest.output.sha256,
        environment: independentEnvironment,
      },
    },
    execution: {
      replayCount: 2,
      networkAllowed: false,
      arbitraryCommandAllowed: false,
      outerObservedProcessRequired: true,
      timeoutMs: 30_000,
      maxOutputBytes: 1_048_576,
      maximumRefinementLevels: 8,
    },
  });
  const certificate = await replayCasimirIndependentNumericalRequestV1({
    request,
    policy: replayPolicy,
    primaryGenerationRequest: primaryGeneration.generationRequest,
    primaryProducerReceipt: primaryGeneration.receipt,
    independentGenerationRequest: independentGeneration.generationRequest,
    independentProducerReceipt: independentGeneration.receipt,
    harnessSourcePath: buildReceipt.harnessSource,
    harnessExecutablePath: buildReceipt.harnessExecutable,
    primarySourcePath,
    primaryBuildManifestPath: PRIMARY_MANIFEST,
    primaryExecutablePath: buildReceipt.primaryExecutable,
    independentSourcePath,
    independentBuildManifestPath: INDEPENDENT_MANIFEST,
    independentExecutablePath: buildReceipt.independentExecutable,
    outputRoot: evidenceRoot,
  });
  const bundle = {
    schema: "casimir_advection_diffusion_numerical_evidence_bundle/v1",
    generatedAt: new Date().toISOString(),
    case: { inputs: caseInputs, mesh, initialConditions, boundaryConditions },
    primaryGeneration,
    independentGeneration,
    request,
    replayPolicy,
    certificate,
    authority: {
      frozenNumericalComparisonChecked:
        certificate.authority.frozenNumericalComparisonChecked,
      validatesNumericalImplementation: false,
      validatesTheory: false,
      validatesEmpiricalClaim: false,
      validatesPhysicalMechanism: false,
      assistantAnswer: false,
      terminalEligible: false,
    },
  };
  await fs.writeFile(
    path.join(evidenceRoot, "evidence-bundle.json"),
    JSON.stringify(bundle, null, 2),
    { encoding: "utf8", flag: "wx" },
  );
  process.stdout.write(
    `${JSON.stringify(
      {
        status: certificate.status,
        certificateId: certificate.certificateId,
        certificateSha256: certificate.artifactSha256,
        comparisons: certificate.comparisons,
        blockers: certificate.blockers,
        authority: certificate.authority,
        evidenceBundle: path.join(evidenceRoot, "evidence-bundle.json"),
      },
      null,
      2,
    )}\n`,
  );
}

main().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exitCode = 1;
});
