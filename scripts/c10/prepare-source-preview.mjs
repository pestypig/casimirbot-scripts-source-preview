import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, hash, inventory } from './build-local-kit.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export function prepare(destination) {
  const output = path.resolve(destination);
  fs.mkdirSync(output, { recursive: false });
  const candidate = build(path.join(output, 'mit-candidate'), { mitCandidate: true });
  const sourceDir = path.join(output, 'source-preview');
  fs.cpSync(candidate.packageDir, sourceDir, { recursive: true, errorOnExist: true, force: false });

  const sourceInventory = inventory(path.join(candidate.packageDir, 'src'));
  const distInventory = inventory(path.join(candidate.packageDir, 'dist'));
  const javaInventory = inventory(path.join(candidate.packageDir, 'java'));
  fs.writeFileSync(path.join(sourceDir, 'README.md'), `# CasimirBot environment connector kit — source preview

CasimirBot is a Windows research workstation and environment harness for working with AI inside real software. This repository is a selected **read-only connector source preview**: versioned v1 wire schemas, a TypeScript transport client, a Java 21 transport helper, system-clock and synthetic examples, a read-only template, and an in-memory mock.

The source is available under MIT for inspection, modification and reuse. See [LICENSE](LICENSE) for the first-party grant and [THIRD_PARTY_NOTICES.txt](THIRD_PARTY_NOTICES.txt) for the declared Zod dependency. This repository has clean history and contains only the selected 43-export closure. It is not the CasimirBot desktop, server, room service, account system, or full source tree.

## Build from source

Use Node 20+ and npm. The reviewed build uses TypeScript 5.6.3 and @types/node 22.20.5. Run:

\`\`\`sh
npm install
npm run build
\`\`\`

The build regenerates \`dist/\` from the eleven selected TypeScript files in \`src/\`. The archive also includes a Java transport helper at \`java/com/casimirbot/helix/environment/HelixConnectorClient.java\`; compile it with JDK 21. The package is marked \`private: true\` to prevent accidental npm registry publication. You can inspect its local exports and examples through \`package.json\`.

## Scope and current limits

The examples demonstrate synthetic reachability and a read-only system-clock observation. The mock is an in-memory test fixture, not an authorization server. Real endpoint use requires a registered connector package, account/session checks, owner approval during pairing, and a supported CasimirBot installation. This source preview has **not** completed independent-developer onboarding or production pairing acceptance. It does not supply a generic action SDK, hosted entitlement, model runtime, or a public connector directory admission.

The desktop and account overview live at [casimirbot.com](https://casimirbot.com). The public desktop download is a separate release channel; availability of this source does not establish that a particular desktop build exposes this kit.

## Provenance

\`provenance.json\` records the canonical input hashes, selected exports, dependency versions and generated source hashes. The selected source and compiled outputs match the verified MIT candidate. The public README and this repository's history are prepared separately from the private product repository.
`);
  fs.writeFileSync(path.join(sourceDir, '.gitignore'), 'node_modules/\nout/\n*.tgz\n');
  const provenancePath = path.join(sourceDir, 'provenance.json');
  const provenance = JSON.parse(fs.readFileSync(provenancePath, 'utf8'));
  provenance.purpose = 'source-only-public-preview';
  provenance.sourcePreview = {
    sourceFiles: Object.keys(sourceInventory).length,
    sourceInventoryHash: hash(JSON.stringify(sourceInventory)),
    distInventoryHash: hash(JSON.stringify(distInventory)),
    javaInventoryHash: hash(JSON.stringify(javaInventory)),
    npmRegistryPublication: false,
  };
  fs.writeFileSync(provenancePath, JSON.stringify(provenance, null, 2) + '\n');

  for (const folder of ['src', 'dist', 'java']) {
    const expected = inventory(path.join(candidate.packageDir, folder));
    const actual = inventory(path.join(sourceDir, folder));
    if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`source_preview_${folder}_drift`);
  }
  const expectedLicense = fs.readFileSync(path.join(root, 'packages/create-casimir-verifier/LICENSE'));
  if (!fs.readFileSync(path.join(sourceDir, 'LICENSE')).equals(expectedLicense)) throw new Error('mit_license_drift');
  if (!fs.readFileSync(path.join(sourceDir, 'THIRD_PARTY_NOTICES.txt'), 'utf8').includes('Runtime dependency: zod'))
    throw new Error('zod_notice_missing');
  const manifest = JSON.parse(fs.readFileSync(path.join(sourceDir, 'package.json'), 'utf8'));
  if (manifest.private !== true || manifest.license !== 'MIT') throw new Error('source_preview_manifest_invalid');

  const files = inventory(sourceDir);
  fs.writeFileSync(path.join(output, 'source-preview-inventory.json'), JSON.stringify(files, null, 2) + '\n');
  return { output, sourceDir, candidateDir: candidate.packageDir, files: Object.keys(files).length,
    treeHash: hash(JSON.stringify(files)), sourceFiles: Object.keys(sourceInventory).length };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv[2] || process.argv[3])
    throw new Error('usage: node scripts/c10/prepare-source-preview.mjs <new-output-directory>');
  console.log(JSON.stringify(prepare(process.argv[2]), null, 2));
}
