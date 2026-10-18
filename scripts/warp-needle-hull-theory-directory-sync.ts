import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

type PathSpec = {
  path: string;
  required: boolean;
};

type TheoryDirectoryConfig = {
  artifact_type: string;
  generator_version: string;
  alias: string;
  theory_name: string;
  theory_slug: string;
  boundary_statement: string;
  root_directory: string;
  outputs: {
    latest_json: string;
    latest_md: string;
    dated_json_template: string;
    dated_md_template: string;
  };
  sections: Record<string, PathSpec[]>;
  regeneration_commands: string[];
};

type IndexedPath = PathSpec & {
  exists: boolean;
};

type TheoryDirectoryOutput = {
  artifact_type: string;
  generator_version: string;
  alias: string;
  theory_name: string;
  theory_slug: string;
  boundary_statement: string;
  generated_at_utc: string;
  commit_pin: string | null;
  root_directory: string;
  entrypoints: {
    latest_json: string;
    latest_md: string;
    dated_json: string;
    dated_md: string;
  };
  summary: {
    required_total: number;
    required_missing: number;
    optional_total: number;
    optional_missing: number;
    overall_status: 'READY' | 'PARTIAL';
  };
  missing_required_paths: string[];
  sections: Record<string, IndexedPath[]>;
  regeneration_commands: string[];
};

const DEFAULT_CONFIG_PATH = path.join('configs', 'warp-needle-hull-mark2-theory-directory.v1.json');

const normalizePath = (value: string): string => value.replace(/\\/g, '/');

const readJson = <T>(filePath: string): T =>
  JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;

const ensureParentDir = (filePath: string): void => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
};

const assert = (condition: unknown, message: string): void => {
  if (!condition) {
    throw new Error(message);
  }
};

const readArg = (name: string, argv = process.argv.slice(2)): string | undefined => {
  const index = argv.findIndex((item) => item === name || item.startsWith(`${name}=`));
  if (index < 0) {
    return undefined;
  }
  if (argv[index].includes('=')) {
    return argv[index].split('=', 2)[1];
  }
  return argv[index + 1];
};

const resolveTemplate = (template: string, date: string): string =>
  template.replaceAll('{date}', date);

const getHeadCommit = (): string | null => {
  try {
    return execSync('git rev-parse HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
  } catch {
    return null;
  }
};

const toDateOnly = (isoUtc: string): string => isoUtc.slice(0, 10);

const buildMarkdown = (payload: TheoryDirectoryOutput, sourcePath: string): string => {
  const lines: string[] = [];
  lines.push(`# ${payload.theory_name} Theory Directory (${payload.alias})`);
  lines.push('');
  lines.push(`"${payload.boundary_statement}"`);
  lines.push('');
  lines.push('## Identity');
  lines.push(`- artifact_type: \`${payload.artifact_type}\``);
  lines.push(`- theory_slug: \`${payload.theory_slug}\``);
  lines.push(`- generated_at_utc: \`${payload.generated_at_utc}\``);
  lines.push(`- commit_pin: \`${payload.commit_pin ?? 'UNKNOWN'}\``);
  lines.push(`- source_config: \`${normalizePath(sourcePath)}\``);
  lines.push('');
  lines.push('## Entry Points');
  lines.push(`- root_directory: \`${normalizePath(payload.root_directory)}\``);
  lines.push(`- latest_json: \`${normalizePath(payload.entrypoints.latest_json)}\``);
  lines.push(`- latest_md: \`${normalizePath(payload.entrypoints.latest_md)}\``);
  lines.push(`- dated_json: \`${normalizePath(payload.entrypoints.dated_json)}\``);
  lines.push(`- dated_md: \`${normalizePath(payload.entrypoints.dated_md)}\``);
  lines.push('');
  lines.push('## Summary');
  lines.push(`- overall_status: \`${payload.summary.overall_status}\``);
  lines.push(`- required_missing: \`${payload.summary.required_missing}/${payload.summary.required_total}\``);
  lines.push(`- optional_missing: \`${payload.summary.optional_missing}/${payload.summary.optional_total}\``);
  lines.push('');

  if (payload.missing_required_paths.length > 0) {
    lines.push('## Missing Required Paths');
    payload.missing_required_paths.forEach((entry) => lines.push(`- \`${normalizePath(entry)}\``));
    lines.push('');
  }

  lines.push('## Sections');
  for (const [sectionName, items] of Object.entries(payload.sections)) {
    lines.push(`### ${sectionName}`);
    items.forEach((item) => {
      const requiredText = item.required ? 'required' : 'optional';
      const statusText = item.exists ? 'present' : 'missing';
      lines.push(`- [${requiredText}/${statusText}] \`${normalizePath(item.path)}\``);
    });
    lines.push('');
  }

  lines.push('## Regeneration Commands');
  payload.regeneration_commands.forEach((command, index) => {
    lines.push(`${index + 1}. \`${command}\``);
  });
  lines.push('');
  return lines.join('\n');
};

const validateConfig = (config: TheoryDirectoryConfig): void => {
  assert(
    config.artifact_type === 'needle_hull_mark2_theory_directory/v1',
    'artifact_type must be needle_hull_mark2_theory_directory/v1',
  );
  assert(typeof config.theory_name === 'string' && config.theory_name.length > 0, 'theory_name is required');
  assert(typeof config.theory_slug === 'string' && config.theory_slug.length > 0, 'theory_slug is required');
  assert(typeof config.boundary_statement === 'string' && config.boundary_statement.length > 0, 'boundary_statement is required');
  assert(typeof config.root_directory === 'string' && config.root_directory.length > 0, 'root_directory is required');
  assert(
    typeof config.outputs?.latest_json === 'string' &&
      typeof config.outputs?.latest_md === 'string' &&
      typeof config.outputs?.dated_json_template === 'string' &&
      typeof config.outputs?.dated_md_template === 'string',
    'outputs.latest_json/latest_md/dated templates are required',
  );
  assert(
    config.sections &&
      typeof config.sections === 'object' &&
      Object.keys(config.sections).length > 0,
    'sections are required',
  );
  for (const [section, entries] of Object.entries(config.sections)) {
    assert(Array.isArray(entries), `section ${section} must be an array`);
    entries.forEach((entry, index) => {
      assert(typeof entry.path === 'string' && entry.path.length > 0, `section ${section} entry ${index} missing path`);
      assert(typeof entry.required === 'boolean', `section ${section} entry ${index} missing required boolean`);
    });
  }
  assert(
    Array.isArray(config.regeneration_commands) && config.regeneration_commands.length > 0,
    'regeneration_commands is required',
  );
};

export const syncNeedleHullTheoryDirectory = (options: { configPath?: string }) => {
  const configPath = options.configPath ?? DEFAULT_CONFIG_PATH;
  const config = readJson<TheoryDirectoryConfig>(configPath);
  validateConfig(config);

  const nowIso = new Date().toISOString();
  const dateOnly = toDateOnly(nowIso);
  const datedJson = resolveTemplate(config.outputs.dated_json_template, dateOnly);
  const datedMd = resolveTemplate(config.outputs.dated_md_template, dateOnly);

  const indexedSections: Record<string, IndexedPath[]> = {};
  let requiredTotal = 0;
  let requiredMissing = 0;
  let optionalTotal = 0;
  let optionalMissing = 0;
  const missingRequiredPaths: string[] = [];

  for (const [sectionName, entries] of Object.entries(config.sections)) {
    const mapped = entries.map((entry) => {
      const exists = fs.existsSync(entry.path);
      if (entry.required) {
        requiredTotal += 1;
        if (!exists) {
          requiredMissing += 1;
          missingRequiredPaths.push(entry.path);
        }
      } else {
        optionalTotal += 1;
        if (!exists) {
          optionalMissing += 1;
        }
      }
      return {
        path: normalizePath(entry.path),
        required: entry.required,
        exists,
      };
    });
    indexedSections[sectionName] = mapped;
  }

  const output: TheoryDirectoryOutput = {
    artifact_type: config.artifact_type,
    generator_version: config.generator_version,
    alias: config.alias,
    theory_name: config.theory_name,
    theory_slug: config.theory_slug,
    boundary_statement: config.boundary_statement,
    generated_at_utc: nowIso,
    commit_pin: getHeadCommit(),
    root_directory: normalizePath(config.root_directory),
    entrypoints: {
      latest_json: normalizePath(config.outputs.latest_json),
      latest_md: normalizePath(config.outputs.latest_md),
      dated_json: normalizePath(datedJson),
      dated_md: normalizePath(datedMd),
    },
    summary: {
      required_total: requiredTotal,
      required_missing: requiredMissing,
      optional_total: optionalTotal,
      optional_missing: optionalMissing,
      overall_status: requiredMissing === 0 ? 'READY' : 'PARTIAL',
    },
    missing_required_paths: missingRequiredPaths.map((value) => normalizePath(value)),
    sections: indexedSections,
    regeneration_commands: config.regeneration_commands,
  };

  [config.outputs.latest_json, config.outputs.latest_md, datedJson, datedMd].forEach((filePath) =>
    ensureParentDir(filePath),
  );

  const markdown = buildMarkdown(output, configPath);
  fs.writeFileSync(config.outputs.latest_json, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
  fs.writeFileSync(datedJson, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
  fs.writeFileSync(config.outputs.latest_md, markdown, 'utf8');
  fs.writeFileSync(datedMd, markdown, 'utf8');

  const readmePath = path.join(config.root_directory, 'README.md');
  ensureParentDir(readmePath);
  const readme = `# ${config.theory_name}

Canonical cohesive directory for this theory:
- machine index: \`${normalizePath(config.outputs.latest_json)}\`
- human index: \`${normalizePath(config.outputs.latest_md)}\`

Primary command:
- \`npm run warp:needle-hull:directory:sync\`
`;
  fs.writeFileSync(readmePath, readme, 'utf8');

  return {
    config: normalizePath(configPath),
    latest_json: normalizePath(config.outputs.latest_json),
    latest_md: normalizePath(config.outputs.latest_md),
    dated_json: normalizePath(datedJson),
    dated_md: normalizePath(datedMd),
    overall_status: output.summary.overall_status,
    required_missing: output.summary.required_missing,
  };
};

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const configPath = readArg('--config');
  const result = syncNeedleHullTheoryDirectory({ configPath });
  console.log(JSON.stringify(result, null, 2));
}
