import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const ledgerPath = 'docs/work-packets/eh-g8-cfp1-c10-public-symbol-allowlist-v1.csv';
const dependencyModules = [
  'shared/helix-environment-state-snapshot.ts',
  'shared/helix-environment-sensor-scope.ts',
];
const helpers = [
  'connectors/environment/sdk/typescript/index.ts',
  'connectors/environment/examples/system-clock/connector.ts',
  'connectors/environment/examples/synthetic/connector.ts',
  'connectors/environment/templates/read-only/connector.ts',
  'connectors/environment/conformance/mock-helix.ts',
];
const javaPath = 'connectors/environment/sdk/java/src/main/java/com/casimirbot/helix/environment/HelixConnectorClient.java';
export const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const slash = value => value.replaceAll('\\', '/');
const read = name => fs.readFileSync(path.join(root, name), 'utf8');
const write = (base, name, text) => {
  const target = path.join(base, name);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, text);
};
export function ledger() {
  return read(ledgerPath).trim().split(/\r?\n/).slice(1).map(line => {
    const [symbol, source_module, candidate, reason] = line.split(',');
    return { symbol, source_module, candidate, reason };
  });
}
export function inventory(directory) {
  const result = {};
  function walk(base) {
    for (const entry of fs.readdirSync(base, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(base, entry.name);
      if (entry.isSymbolicLink()) throw new Error('symlink_not_allowed');
      if (entry.isDirectory()) walk(file);
      else result[slash(path.relative(directory, file))] = hash(fs.readFileSync(file));
    }
  }
  walk(directory);
  return result;
}

// Traverse checker-resolved declarations, not identifier text: shadowed locals
// and property names must not drag unrelated top-level declarations into output.
export function selectedClosure(rows = ledger()) {
  const selected = rows.filter(row => row.candidate === 'include');
  if (selected.length !== 43 || new Set(selected.map(row => row.symbol)).size !== 43)
    throw new Error('expected_exactly_43_selected_exports');
  const modules = [...new Set([...rows.map(row => row.source_module), ...dependencyModules])];
  const allowed = new Set(modules.map(file => slash(path.join(root, file))));
  const program = ts.createProgram(modules.map(file => path.join(root, file)), {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler, types: [], skipLibCheck: true,
  });
  const checker = program.getTypeChecker();
  const statements = new Set();
  const bindings = new Set();
  const queue = [];
  function includeSymbol(symbol) {
    if (!symbol) return;
    for (const declaration of symbol.declarations ?? []) {
      const source = declaration.getSourceFile();
      if (!allowed.has(slash(source.fileName))) {
        if (!slash(source.fileName).includes('/node_modules/'))
          throw new Error(`unreviewed_dependency:${source.fileName}`);
        continue;
      }
      if (ts.isImportSpecifier(declaration) || ts.isImportClause(declaration) || ts.isNamespaceImport(declaration)) {
        bindings.add(declaration);
        if (symbol.flags & ts.SymbolFlags.Alias) includeSymbol(checker.getAliasedSymbol(symbol));
        continue;
      }
      let statement = declaration;
      while (statement.parent && !ts.isSourceFile(statement.parent)) statement = statement.parent;
      if (!statements.has(statement)) { statements.add(statement); queue.push(statement); }
    }
  }
  for (const row of selected) {
    const source = program.getSourceFile(path.join(root, row.source_module));
    const symbol = checker.getExportsOfModule(checker.getSymbolAtLocation(source)).find(item => item.name === row.symbol);
    if (!symbol) throw new Error(`selected_export_missing:${row.symbol}`);
    includeSymbol(symbol);
  }
  while (queue.length) {
    const visit = node => {
      if (ts.isIdentifier(node)) includeSymbol(checker.getSymbolAtLocation(node));
      ts.forEachChild(node, visit);
    };
    visit(queue.shift());
  }
  const printer = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed, removeComments: true });
  const files = {};
  for (const name of modules) {
    const source = program.getSourceFile(path.join(root, name));
    const kept = [];
    for (const statement of source.statements) {
      if (ts.isImportDeclaration(statement)) {
        const clause = statement.importClause;
        if (!clause) throw new Error(`side_effect_import_not_allowed:${name}`);
        const named = clause.namedBindings;
        const elements = named && ts.isNamedImports(named) ? named.elements.filter(item => bindings.has(item)) : [];
        const defaultName = bindings.has(clause) ? clause.name : undefined;
        const namespace = named && ts.isNamespaceImport(named) && bindings.has(named) ? named : undefined;
        if (elements.length || defaultName || namespace) {
          const specifier = statement.moduleSpecifier.text;
          if (!specifier.startsWith('.') && specifier !== 'zod') throw new Error(`unreviewed_import:${specifier}`);
          kept.push(ts.factory.updateImportDeclaration(statement, statement.modifiers,
            ts.factory.updateImportClause(clause, clause.isTypeOnly, defaultName,
              namespace ?? (elements.length ? ts.factory.createNamedImports(elements) : undefined)),
            ts.factory.createStringLiteral(specifier.startsWith('.') ? `${specifier}.js` : specifier), undefined));
        }
      } else if (statements.has(statement)) kept.push(statement);
    }
    if (kept.length) files[name] = kept.map(statement => printer.printNode(ts.EmitHint.Unspecified, statement, source)).join('\n') + '\n';
  }
  for (const row of rows.filter(row => row.candidate === 'defer')) {
    const source = program.getSourceFile(path.join(root, row.source_module));
    const symbol = checker.getExportsOfModule(checker.getSymbolAtLocation(source)).find(item => item.name === row.symbol);
    for (const declaration of symbol?.declarations ?? []) {
      let statement = declaration;
      while (statement.parent && !ts.isSourceFile(statement.parent)) statement = statement.parent;
      if (statements.has(statement)) throw new Error(`deferred_declaration_leak:${row.symbol}`);
    }
  }
  files['connectors/environment/contract/v1/index.ts'] = selected.map(row => {
    const source = program.getSourceFile(path.join(root, row.source_module));
    const symbol = checker.getExportsOfModule(checker.getSymbolAtLocation(source)).find(item => item.name === row.symbol);
    const type = symbol.flags & ts.SymbolFlags.Value ? '' : 'type ';
    return `export ${type}{ ${row.symbol} } from "../../../../${row.source_module.replace(/\.ts$/, '.js')}";`;
  }).join('\n') + '\n';
  return { files, selected };
}

export function build(destination, { mitCandidate = false } = {}) {
  const output = path.resolve(destination);
  // Never clean or overwrite: each experiment gets a fresh directory.
  fs.mkdirSync(output, { recursive: false });
  const sourceDir = path.join(output, 'generated');
  const packageDir = path.join(output, 'package');
  const { files, selected } = selectedClosure();
  for (const helper of helpers) files[helper] = read(helper)
    .replaceAll('"../../contract/v1"', '"../../contract/v1/index.js"')
    .replaceAll('"../contract/v1"', '"../contract/v1/index.js"')
    .replaceAll('"../../sdk/typescript"', '"../../sdk/typescript/index.js"')
    .replaceAll('"../sdk/typescript"', '"../sdk/typescript/index.js"');
  for (const [name, content] of Object.entries(files)) {
    write(sourceDir, name, content);
    write(packageDir, `src/${name}`, content);
  }
  const options = {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler, strict: true, skipLibCheck: true,
    declaration: true, noEmitOnError: true, esModuleInterop: true,
    types: ['node'], typeRoots: [path.join(root, 'node_modules/@types')],
    baseUrl: root, paths: { zod: ['node_modules/zod'] },
    rootDir: sourceDir, outDir: path.join(packageDir, 'dist'),
  };
  const program = ts.createProgram(Object.keys(files).map(file => path.join(sourceDir, file)), options);
  const diagnostics = ts.getPreEmitDiagnostics(program);
  if (diagnostics.length) throw new Error(ts.formatDiagnosticsWithColorAndContext(diagnostics, {
    getCurrentDirectory: () => root, getCanonicalFileName: name => name, getNewLine: () => '\n',
  }));
  const emitted = program.emit();
  if (emitted.emitSkipped) throw new Error('emit_skipped');
  const zod = JSON.parse(read('node_modules/zod/package.json'));
  const typescript = JSON.parse(read('node_modules/typescript/package.json'));
  const nodeTypes = JSON.parse(read('node_modules/@types/node/package.json'));
  const entry = file => ({ types: `./dist/${file}.d.ts`, import: `./dist/${file}.js` });
  const prefix = 'connectors/environment/';
  write(packageDir, 'package.json', JSON.stringify({
    name: '@casimirbot/environment-connector-kit', version: mitCandidate ? '0.1.0-mit-candidate.1' : '0.1.0-local.1', private: true,
    license: mitCandidate ? 'MIT' : 'UNLICENSED', type: 'module', engines: { node: '>=20' },
    exports: {
      '.': entry(`${prefix}contract/v1/index`),
      './sdk': entry(`${prefix}sdk/typescript/index`),
      './examples/system-clock': entry(`${prefix}examples/system-clock/connector`),
      './examples/synthetic': entry(`${prefix}examples/synthetic/connector`),
      './templates/read-only': entry(`${prefix}templates/read-only/connector`),
      './testing/mock': entry(`${prefix}conformance/mock-helix`),
    },
    scripts: { build: 'tsc -p tsconfig.build.json' },
    dependencies: { zod: zod.version },
    devDependencies: { typescript: typescript.version, '@types/node': nodeTypes.version },
    files: ['dist', 'src', 'java', 'tsconfig.build.json', 'README.md', 'LICENSE', 'THIRD_PARTY_NOTICES.txt', 'provenance.json'],
  }, null, 2) + '\n');
  write(packageDir, 'tsconfig.build.json', JSON.stringify({
    compilerOptions: {
      target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler',
      strict: true, skipLibCheck: true, declaration: true, noEmitOnError: true,
      esModuleInterop: true, types: ['node'], rootDir: 'src', outDir: 'dist',
    },
    include: ['src/**/*.ts'],
  }, null, 2) + '\n');
  write(packageDir, 'java/com/casimirbot/helix/environment/HelixConnectorClient.java', read(javaPath));
  write(packageDir, 'LICENSE', mitCandidate
    ? read('packages/create-casimir-verifier/LICENSE')
    : 'Private local evaluation candidate. No public license grant. Distribution and rights review pending.\n');
  write(packageDir, 'THIRD_PARTY_NOTICES.txt', `Runtime dependency: zod ${zod.version}, ${zod.license}.\nNot bundled; installed as declared dependency.\n\n${read('node_modules/zod/LICENSE')}\nJava helper uses only JDK standard libraries. Node built-ins: crypto, fetch, Buffer.\n`);
  write(packageDir, 'README.md', `# ${mitCandidate ? 'MIT release candidate' : 'Private C10 read-only connector candidate'}\n\n${mitCandidate ? 'Prepared for a possible public source release; this archive has not been published or cleared for distribution. First-party code is marked MIT at the owner\'s direction. The included third-party notice covers Zod.' : 'Local evaluation only; not a published or rights-cleared release.'}\n\nRequires Node 20+; compiled and consumer-tested with TypeScript ${typescript.version} and @types/node ${nodeTypes.version}. Other TypeScript versions are unqualified. Java helper requires JDK 21.\n\nThe selected TypeScript source used for this build is included under src/. Compiled JavaScript and declarations are under dist/. The src/ tree is a selected closure of the canonical modules, not a copy of every private repository export. The included tsconfig.build.json and pinned development dependencies are the source build recipe; npm install and npm run build rebuild dist/ from src/ in an unpacked copy.\n\nInstall the supplied archive with npm install --ignore-scripts <archive.tgz>. Import contract symbols from @casimirbot/environment-connector-kit and the client from its /sdk entry point. The /examples/system-clock handler reads process uptime. /testing/mock is an in-memory transport fixture, not an authorization server.\n\nThe real endpoint requires the registered com.casimirbot.system.clock:1.0.0 package and owner approval during pairing. Unknown third-party packages are not supported. Local compilation and mock probes do not prove real pairing, public directory admission, independent developer usability or installed acceptance. No action SDK, model runtime or hosted entitlement is supplied.\n`);
  const inputs = [...new Set([ledgerPath, ...Object.keys(files).filter(name => name !== `${prefix}contract/v1/index.ts`), javaPath, 'scripts/c10/build-local-kit.mjs'])].sort();
  write(packageDir, 'provenance.json', JSON.stringify({
    purpose: mitCandidate ? 'mit-source-release-candidate-review' : 'private-local-proof-only', wireVersion: 'v1',
    selectedExports: selected.map(row => row.symbol).sort(),
    inputs: Object.fromEntries(inputs.map(file => [file, hash(fs.readFileSync(path.join(root, file)))])),
    generatedSource: Object.fromEntries(Object.entries(files).map(([file, content]) => [file, hash(content)])),
    tools: { node: process.version, typescript: typescript.version, nodeTypes: nodeTypes.version },
    dependencies: { zod: { version: zod.version, license: zod.license } },
  }, null, 2) + '\n');
  write(output, 'inventory.json', JSON.stringify(inventory(packageDir), null, 2) + '\n');
  return { output, packageDir, exports: selected.length, files: Object.keys(inventory(packageDir)).length };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv[2] || (process.argv[3] && process.argv[3] !== '--mit-candidate'))
    throw new Error('usage: node scripts/c10/build-local-kit.mjs <new-output-directory> [--mit-candidate]');
  console.log(JSON.stringify(build(process.argv[2], { mitCandidate: process.argv[3] === '--mit-candidate' }), null, 2));
}
