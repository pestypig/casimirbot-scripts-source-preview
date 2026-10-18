import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

import {
  HELIX_MCP_EVIDENCE_CAPABILITY_DESCRIPTORS,
} from "../../shared/helix-mcp-evidence-capability-registry";
import {
  helixMcpEvidenceCapabilityDescriptorSchema,
  type HelixMcpEvidenceCapabilityDescriptor,
} from "../../shared/contracts/helix-mcp-evidence-capability.v1";

export const HELIX_MCP_EVIDENCE_INVENTORY_AUDIT_SCHEMA =
  "helix.mcp_evidence_inventory_audit.v1" as const;

const MCP_SOURCE_SURFACES = [
  {
    relativePath: "server/mcp/helix-mcp-server.ts",
    surface: "full_helix_mcp",
  },
  {
    relativePath: "server/mcp/helix-run-mcp-server.ts",
    surface: "run_mcp",
  },
] as const;

type McpSourceSurface = (typeof MCP_SOURCE_SURFACES)[number]["surface"];

export type HelixMcpRegistrationSite = {
  source_file: string;
  source_line: number;
  surface: McpSourceSurface;
  declares_input_schema: boolean;
  declares_output_schema: boolean;
  declares_oauth_metadata: boolean;
  annotations: {
    read_only: boolean | null;
    destructive: boolean | null;
    idempotent: boolean | null;
    open_world: boolean | null;
  };
};

export type HelixMcpEvidenceInventoryTool = {
  mcp_tool_name: string;
  registration_sites: HelixMcpRegistrationSite[];
  descriptor_state: "joined" | "gap";
  capability_id: string | null;
  gap_reason_codes: string[];
};

export type HelixMcpEvidenceInventoryAudit = {
  schema: typeof HELIX_MCP_EVIDENCE_INVENTORY_AUDIT_SCHEMA;
  source_files: string[];
  registration_count: number;
  unique_tool_count: number;
  joined_tool_count: number;
  gap_tool_count: number;
  tools: HelixMcpEvidenceInventoryTool[];
  unresolved_registrations: Array<{
    source_file: string;
    source_line: number;
    first_argument: string;
  }>;
  orphan_descriptor_tool_names: string[];
  invalid_descriptor_tool_names: string[];
  ok: boolean;
  failures: string[];
};

const property = (
  object: ts.ObjectLiteralExpression,
  name: string,
): ts.PropertyAssignment | null => {
  for (const entry of object.properties) {
    if (!ts.isPropertyAssignment(entry)) continue;
    const key = ts.isIdentifier(entry.name) || ts.isStringLiteral(entry.name)
      ? entry.name.text
      : null;
    if (key === name) return entry;
  }
  return null;
};

const objectProperty = (
  object: ts.ObjectLiteralExpression,
  name: string,
): ts.ObjectLiteralExpression | null => {
  const entry = property(object, name);
  return entry && ts.isObjectLiteralExpression(entry.initializer)
    ? entry.initializer
    : null;
};

const booleanProperty = (
  object: ts.ObjectLiteralExpression | null,
  name: string,
): boolean | null => {
  if (!object) return null;
  const entry = property(object, name);
  if (!entry) return null;
  if (entry.initializer.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (entry.initializer.kind === ts.SyntaxKind.FalseKeyword) return false;
  return null;
};

const isRegisterToolCall = (node: ts.CallExpression): boolean => {
  const expression = node.expression;
  return (
    ts.isPropertyAccessExpression(expression) &&
    expression.name.text === "registerTool"
  );
};

const scanSource = (input: {
  workspaceRoot: string;
  relativePath: string;
  surface: McpSourceSurface;
}): {
  registrations: Array<{ toolName: string; site: HelixMcpRegistrationSite }>;
  unresolved: HelixMcpEvidenceInventoryAudit["unresolved_registrations"];
} => {
  const absolutePath = path.resolve(input.workspaceRoot, input.relativePath);
  const sourceText = fs.readFileSync(absolutePath, "utf8");
  const source = ts.createSourceFile(
    absolutePath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const registrations: Array<{ toolName: string; site: HelixMcpRegistrationSite }> = [];
  const unresolved: HelixMcpEvidenceInventoryAudit["unresolved_registrations"] = [];
  // Resolve only direct immutable exported strings; never execute source code.
  const importedStrings = new Map<string, string>();
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const bindings = statement.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    const specifier = statement.moduleSpecifier.text;
    const base = specifier.startsWith("@shared/")
      ? path.join(input.workspaceRoot, "shared", specifier.slice(8))
      : specifier.startsWith(".") ? path.resolve(path.dirname(absolutePath), specifier) : null;
    if (!base) continue;
    const modulePath = [base, `${base}.ts`].find(file => fs.existsSync(file) && fs.statSync(file).isFile());
    if (!modulePath) continue;
    const module = ts.createSourceFile(modulePath, fs.readFileSync(modulePath, "utf8"), ts.ScriptTarget.Latest, true);
    for (const declaration of module.statements) {
      if (!ts.isVariableStatement(declaration) || !(declaration.declarationList.flags & ts.NodeFlags.Const) ||
          !declaration.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword)) continue;
      for (const value of declaration.declarationList.declarations) {
        const literal = value.initializer && ts.isAsExpression(value.initializer) ? value.initializer.expression : value.initializer;
        if (!ts.isIdentifier(value.name) || !literal || !ts.isStringLiteralLike(literal)) continue;
        for (const binding of bindings.elements) {
          if (!binding.isTypeOnly && (binding.propertyName ?? binding.name).text === value.name.text)
            importedStrings.set(binding.name.text, literal.text);
        }
      }
    }
  }
  const toolNames = (expression: ts.Expression | undefined, node: ts.Node): string[] | null => {
    if (!expression) return null;
    if (ts.isStringLiteralLike(expression)) return [expression.text];
    if (ts.isIdentifier(expression)) {
      const value = importedStrings.get(expression.text);
      return value ? [value] : null;
    }
    if (!ts.isTemplateExpression(expression) || expression.templateSpans.length !== 1) return null;
    const span = expression.templateSpans[0];
    if (!ts.isIdentifier(span.expression)) return null;
    for (let parent = node.parent; parent; parent = parent.parent) {
      if (!ts.isForOfStatement(parent) || !ts.isVariableDeclarationList(parent.initializer) ||
          !(parent.initializer.flags & ts.NodeFlags.Const) || parent.initializer.declarations.length !== 1) continue;
      const variable = parent.initializer.declarations[0].name;
      if (!ts.isIdentifier(variable) || variable.text !== span.expression.text) continue;
      const list = ts.isAsExpression(parent.expression) ? parent.expression.expression : parent.expression;
      if (!ts.isArrayLiteralExpression(list) || !list.elements.length || list.elements.length > 32 ||
          !list.elements.every(ts.isStringLiteralLike)) return null;
      return list.elements.map(item => expression.head.text + (item as ts.StringLiteralLike).text + span.literal.text);
    }
    return null;
  };

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && isRegisterToolCall(node)) {
      const firstArgument = node.arguments[0];
      const names = toolNames(firstArgument, node);
      const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
      if (!names) {
        unresolved.push({
          source_file: input.relativePath,
          source_line: line,
          first_argument: firstArgument?.getText(source) ?? "missing",
        });
      } else {
        const configuration = node.arguments[1];
        const configurationObject = configuration && ts.isObjectLiteralExpression(configuration)
          ? configuration
          : null;
        const annotations = configurationObject
          ? objectProperty(configurationObject, "annotations")
          : null;
        for (const toolName of names) registrations.push({
          toolName,
          site: {
            source_file: input.relativePath,
            source_line: line,
            surface: input.surface,
            declares_input_schema: Boolean(configurationObject && property(configurationObject, "inputSchema")),
            declares_output_schema: Boolean(configurationObject && property(configurationObject, "outputSchema")),
            declares_oauth_metadata: Boolean(configurationObject && property(configurationObject, "_meta")),
            annotations: {
              read_only: booleanProperty(annotations, "readOnlyHint"),
              destructive: booleanProperty(annotations, "destructiveHint"),
              idempotent: booleanProperty(annotations, "idempotentHint"),
              open_world: booleanProperty(annotations, "openWorldHint"),
            },
          },
        });
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(source);
  return { registrations, unresolved };
};

const descriptorMap = (
  descriptors: readonly HelixMcpEvidenceCapabilityDescriptor[],
): {
  valid: Map<string, HelixMcpEvidenceCapabilityDescriptor>;
  invalidToolNames: string[];
} => {
  const valid = new Map<string, HelixMcpEvidenceCapabilityDescriptor>();
  const invalidToolNames: string[] = [];
  for (const descriptor of descriptors) {
    const parsed = helixMcpEvidenceCapabilityDescriptorSchema.safeParse(descriptor);
    if (!parsed.success || valid.has(descriptor.mcp_tool_name)) {
      invalidToolNames.push(descriptor.mcp_tool_name);
      continue;
    }
    valid.set(descriptor.mcp_tool_name, parsed.data);
  }
  return { valid, invalidToolNames: [...new Set(invalidToolNames)].sort() };
};

export const buildHelixMcpEvidenceInventoryAudit = (input: {
  workspaceRoot: string;
  descriptors?: readonly HelixMcpEvidenceCapabilityDescriptor[];
}): HelixMcpEvidenceInventoryAudit => {
  const sourceScans = MCP_SOURCE_SURFACES.map((source) =>
    scanSource({ workspaceRoot: input.workspaceRoot, ...source }),
  );
  const registrations = sourceScans.flatMap((scan) => scan.registrations);
  const unresolvedRegistrations = sourceScans.flatMap((scan) => scan.unresolved);
  const descriptors = descriptorMap(
    input.descriptors ?? HELIX_MCP_EVIDENCE_CAPABILITY_DESCRIPTORS,
  );
  const sitesByTool = new Map<string, HelixMcpRegistrationSite[]>();
  for (const registration of registrations) {
    const sites = sitesByTool.get(registration.toolName) ?? [];
    sites.push(registration.site);
    sitesByTool.set(registration.toolName, sites);
  }

  const tools = [...sitesByTool.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([toolName, sites]): HelixMcpEvidenceInventoryTool => {
      const descriptor = descriptors.valid.get(toolName);
      return {
        mcp_tool_name: toolName,
        registration_sites: sites.sort((left, right) =>
          left.source_file.localeCompare(right.source_file) || left.source_line - right.source_line,
        ),
        descriptor_state: descriptor ? "joined" : "gap",
        capability_id: descriptor?.capability_id ?? null,
        gap_reason_codes: descriptor
          ? []
          : ["mcp_evidence_capability_descriptor_missing"],
      };
    });
  const orphanDescriptorToolNames = [...descriptors.valid.keys()]
    .filter((toolName) => !sitesByTool.has(toolName))
    .sort();
  const failures = [
    ...unresolvedRegistrations.map(
      (entry) => `unresolved_mcp_tool_name:${entry.source_file}:${entry.source_line}:${entry.first_argument}`,
    ),
    ...orphanDescriptorToolNames.map((toolName) => `orphan_mcp_evidence_descriptor:${toolName}`),
    ...descriptors.invalidToolNames.map((toolName) => `invalid_or_duplicate_mcp_evidence_descriptor:${toolName}`),
  ];

  return {
    schema: HELIX_MCP_EVIDENCE_INVENTORY_AUDIT_SCHEMA,
    source_files: MCP_SOURCE_SURFACES.map((source) => source.relativePath),
    registration_count: registrations.length,
    unique_tool_count: tools.length,
    joined_tool_count: tools.filter((tool) => tool.descriptor_state === "joined").length,
    gap_tool_count: tools.filter((tool) => tool.descriptor_state === "gap").length,
    tools,
    unresolved_registrations: unresolvedRegistrations,
    orphan_descriptor_tool_names: orphanDescriptorToolNames,
    invalid_descriptor_tool_names: descriptors.invalidToolNames,
    ok: failures.length === 0,
    failures,
  };
};
