# CasimirBot general scripts source preview

This **MIT-licensed source-only preview** contains 502 selected first-party script paths from CasimirBot's broader non-NHM2-named script triage. The owner has confirmed the right to release first-party code under MIT. The [inventory](SOURCE_SELECTION.json) records the exact selected bytes. Fifty-seven paths have separate environment/scientific reviews, and sixteen tracked temporary debug scripts are withheld.

The exact inventory records one repaired source blob: `scripts/helix-ask-image-lens-acceptance-probe.ts` requires an explicit `--image` argument or `HELIX_ASK_IMAGE_PATH` instead of embedding a developer's local clipboard path. The other 501 script blobs remain pinned to the original source commit. This repair changes no Helix Ask server behavior.

The selection mixes build and test helpers, deployment and provider probes, and research utilities. It is not a standalone CLI, supported deployment kit, or executable product release. Some scripts rely on private services, local configuration, external packages, data, or credentials supplied at runtime. Inclusion does not establish that a script is safe to run against a live service.

In particular, `scripts/hull-mis-clone.ts` can alter an existing local RayTracingMIS checkout's Git remote and branch when run. Review its target directory and upstream terms before executing it; this source snapshot does not include or run that external project.

The [MIT license](LICENSE) covers selected first-party source and authored repository text. The [dependency, data, and operational notes](THIRD_PARTY_NOTICES.md) inventory direct imports and external inputs without bundling them or claiming independent execution support.

Research and warp-related files retain their original exploratory or diagnostic status. No physical viability, accepted proof, or certified gate result is claimed here. Source publication does not grant access to live services, external repositories, data, model weights, or deployment credentials.
