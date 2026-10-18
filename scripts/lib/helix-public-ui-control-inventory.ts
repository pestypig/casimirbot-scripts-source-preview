import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

import type {
  HelixPublicUiAccountScope,
  HelixPublicUiAuthorityState,
  HelixPublicUiInteractionKind,
} from "../../shared/helix-public-ui-affordance";

export type PublicUiSourceScope = {
  surface_id: string;
  account_scope: HelixPublicUiAccountScope;
  default_authority_state: Extract<
    HelixPublicUiAuthorityState,
    "client_local" | "blocked_pending_contract" | "not_applicable"
  >;
  files?: readonly string[];
  directories?: readonly string[];
  exclude_directories?: readonly string[];
  follow_component_imports?: boolean;
};

export type PublicUiControlInventoryEntry = {
  schema: "helix.public_ui_control.v1";
  control_id: string;
  surface_id: string;
  account_scope: HelixPublicUiAccountScope;
  source_path: string;
  line: number;
  element: string;
  locator_kind:
    | "helix_control_id"
    | "test_id"
    | "id"
    | "aria_label"
    | "name"
    | "title"
    | "placeholder"
    | "value"
    | "label"
    | "handler"
    | "line";
  locator: string;
  interaction_kind: HelixPublicUiInteractionKind;
  authority_state: HelixPublicUiAuthorityState;
  capability_id?: string;
  route_contract_id?: string;
  needs_explicit_semantic_id: boolean;
  interaction_classification_source: "explicit" | "mechanical_default";
  authority_classification_source:
    | "capability_binding"
    | "route_binding"
    | "explicit_safe_state"
    | "surface_default";
};

const PUBLIC_PANEL_COMPONENTS: Record<string, string> = {
  "account-session": "client/src/components/workstation/AccountSessionPanel.tsx",
  "local-harness": "client/src/components/workstation/LocalHarnessPanel.tsx",
  "agent-access": "client/src/components/workstation/AgentAccessPanel.tsx",
  "workstation-clipboard-history": "client/src/components/workstation/WorkstationClipboardHistoryPanel.tsx",
  "docs-viewer": "client/src/components/DocViewerPanel.tsx",
  "image-lens": "client/src/components/workstation/ImageLensPanel.tsx",
  narrator: "client/src/components/workstation/NarratorPanel.tsx",
  "agi-task-history": "client/src/components/agi/TaskHistoryPanel.tsx",
  "scientific-calculator": "client/src/components/panels/ScientificCalculatorPanel.tsx",
  "theory-badge-graph": "client/src/components/panels/TheoryBadgeGraphPanel.tsx",
  "workstation-notes": "client/src/components/workstation/WorkstationNotesPanel.tsx",
  "workstation-storage-map": "client/src/components/workstation/WorkstationStorageMapPanel.tsx",
  "workstation-task-manager": "client/src/components/workstation/WorkstationTaskManagerPanel.tsx",
  "moral-graph": "client/src/components/panels/MoralGraphLaunchPanel.tsx",
  "postulate-board": "client/src/components/workstation/PostulateBoardPanel.tsx",
  "workflow-demo-lab": "client/src/components/workstation/WorkflowDemoLabPanel.tsx",
};

export const HELIX_PUBLIC_UI_SOURCE_SCOPES: readonly PublicUiSourceScope[] = [
  {
    surface_id: "workstation.shell",
    account_scope: "user",
    default_authority_state: "client_local",
    files: [
      "client/src/components/workstation/WorkstationPanelTabs.tsx",
      "client/src/components/workstation/WorkstationPanelHost.tsx",
    ],
  },
  {
    surface_id: "workstation.mobile_launcher",
    account_scope: "user",
    default_authority_state: "client_local",
    files: ["client/src/pages/mobile-start.tsx"],
  },
  {
    surface_id: "helix.ask",
    account_scope: "user",
    default_authority_state: "client_local",
    files: ["client/src/components/helix/HelixAskPill.tsx"],
    directories: ["client/src/components/helix/ask-console"],
    exclude_directories: ["shared-live-room", "__tests__"],
  },
  {
    surface_id: "helix.ask.shared_live_room",
    account_scope: "user_feature_gated",
    default_authority_state: "blocked_pending_contract",
    directories: ["client/src/components/helix/ask-console/shared-live-room"],
    exclude_directories: ["__tests__"],
  },
  ...Object.entries(PUBLIC_PANEL_COMPONENTS).map(([panelId, componentPath]) => ({
    surface_id: `workstation.panel.${panelId}`,
    account_scope: "user" as const,
    default_authority_state: "client_local" as const,
    files: [componentPath],
    follow_component_imports: true,
  })),
];

const normalizePath = (value: string): string => value.split(path.sep).join("/");

const readStringAttribute = (
  attributes: ts.JsxAttributes,
  attributeName: string,
): string | undefined => {
  const attribute = attributes.properties.find(
    (candidate): candidate is ts.JsxAttribute =>
      ts.isJsxAttribute(candidate) && candidate.name.getText() === attributeName,
  );
  if (!attribute?.initializer) return undefined;
  if (ts.isStringLiteral(attribute.initializer)) return attribute.initializer.text.trim() || undefined;
  if (
    ts.isJsxExpression(attribute.initializer) &&
    attribute.initializer.expression &&
    ts.isStringLiteralLike(attribute.initializer.expression)
  ) {
    return attribute.initializer.expression.text.trim() || undefined;
  }
  return undefined;
};

const readExpressionAttribute = (
  attributes: ts.JsxAttributes,
  attributeName: string,
): string | undefined => {
  const attribute = attributes.properties.find(
    (candidate): candidate is ts.JsxAttribute =>
      ts.isJsxAttribute(candidate) && candidate.name.getText() === attributeName,
  );
  if (!attribute?.initializer || !ts.isJsxExpression(attribute.initializer)) return undefined;
  return attribute.initializer.expression?.getText().replace(/\s+/g, " ").trim() || undefined;
};

const collectTextLabel = (node: ts.JsxElement): string | undefined => {
  const text = node.children
    .filter(ts.isJsxText)
    .map((child) => child.text)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  return text || undefined;
};

const isInteractive = (tagName: string, attributes: ts.JsxAttributes): boolean => {
  const isIntrinsicElement = /^[a-z][a-z0-9-]*$/.test(tagName);
  const isKnownDomBackedControl = new Set([
    "Button",
    "Checkbox",
    "CommandItem",
    "DropdownMenuItem",
    "Input",
    "SelectTrigger",
    "Slider",
    "Switch",
    "TabsTrigger",
    "Textarea",
  ]).has(tagName);
  if (
    !isIntrinsicElement &&
    !isKnownDomBackedControl &&
    !readStringAttribute(attributes, "data-helix-control-id")
  ) {
    return false;
  }
  if (["button", "input", "select", "textarea"].includes(tagName)) return true;
  if (isKnownDomBackedControl) return true;
  if (tagName === "form" && readExpressionAttribute(attributes, "onSubmit")) return true;
  return Boolean(
    readExpressionAttribute(attributes, "onClick") ||
      readExpressionAttribute(attributes, "onSubmit"),
  );
};

const inferInteractionKind = (
  tagName: string,
  attributes: ts.JsxAttributes,
): HelixPublicUiInteractionKind => {
  const declared = readStringAttribute(attributes, "data-helix-interaction-kind");
  if (["observe", "navigate", "configure", "act", "human_only"].includes(declared ?? "")) {
    return declared as HelixPublicUiInteractionKind;
  }
  if (["input", "select", "textarea"].includes(tagName)) return "configure";
  if (tagName === "form" || readStringAttribute(attributes, "type") === "submit") return "act";
  return "human_only";
};

const hasExplicitInteractionKind = (attributes: ts.JsxAttributes): boolean =>
  Boolean(readStringAttribute(attributes, "data-helix-interaction-kind"));

const inferAuthority = (
  attributes: ts.JsxAttributes,
  defaultAuthorityState: PublicUiSourceScope["default_authority_state"],
): Pick<
  PublicUiControlInventoryEntry,
  "authority_state" | "capability_id" | "route_contract_id" | "authority_classification_source"
> => {
  const capabilityId = readStringAttribute(attributes, "data-helix-capability-id");
  const routeContractId = readStringAttribute(attributes, "data-helix-route-contract-id");
  const declaredAuthority = readStringAttribute(attributes, "data-helix-authority-state");
  if (capabilityId) {
    if (declaredAuthority && declaredAuthority !== "shared_gateway") {
      throw new Error(`Capability-bound control declares incompatible authority: ${declaredAuthority}`);
    }
    return {
      authority_state: "shared_gateway",
      capability_id: capabilityId,
      authority_classification_source: "capability_binding",
    };
  }
  if (routeContractId) {
    if (declaredAuthority && declaredAuthority !== "route_owned") {
      throw new Error(`Route-bound control declares incompatible authority: ${declaredAuthority}`);
    }
    return {
      authority_state: "route_owned",
      route_contract_id: routeContractId,
      authority_classification_source: "route_binding",
    };
  }
  if (declaredAuthority) {
    if (!["client_local", "blocked_pending_contract", "not_applicable"].includes(declaredAuthority)) {
      throw new Error(
        `Control authority ${declaredAuthority} requires an explicit capability or route contract id`,
      );
    }
    return {
      authority_state: declaredAuthority as PublicUiSourceScope["default_authority_state"],
      authority_classification_source: "explicit_safe_state",
    };
  }
  return {
    authority_state: defaultAuthorityState,
    authority_classification_source: "surface_default",
  };
};

const collectBaseSourceFiles = (repoRoot: string, scope: PublicUiSourceScope): string[] => {
  const found = new Set<string>();
  for (const relativePath of scope.files ?? []) {
    const absolutePath = path.resolve(repoRoot, relativePath);
    if (!fs.existsSync(absolutePath)) {
      throw new Error(`Missing public UI source: ${relativePath}`);
    }
    found.add(absolutePath);
  }

  const excluded = new Set(scope.exclude_directories ?? []);
  const walk = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!excluded.has(entry.name)) walk(path.join(directory, entry.name));
      } else if (entry.isFile() && entry.name.endsWith(".tsx") && !/\.(?:spec|test)\.tsx$/.test(entry.name)) {
        found.add(path.join(directory, entry.name));
      }
    }
  };
  for (const relativePath of scope.directories ?? []) {
    const absolutePath = path.resolve(repoRoot, relativePath);
    if (!fs.existsSync(absolutePath)) {
      throw new Error(`Missing public UI directory: ${relativePath}`);
    }
    walk(absolutePath);
  }
  return [...found].sort();
};

const resolveImportedComponent = (
  repoRoot: string,
  fromFile: string,
  specifier: string,
): string | null => {
  let unresolved: string;
  if (specifier.startsWith("@/components/")) {
    unresolved = path.resolve(
      repoRoot,
      "client/src/components",
      specifier.slice("@/components/".length),
    );
  } else if (specifier.startsWith("./") || specifier.startsWith("../")) {
    unresolved = path.resolve(path.dirname(fromFile), specifier);
  } else {
    return null;
  }
  const candidates = unresolved.endsWith(".tsx")
    ? [unresolved]
    : [`${unresolved}.tsx`, path.join(unresolved, "index.tsx")];
  const componentsRoot = path.resolve(repoRoot, "client/src/components");
  for (const candidate of candidates) {
    if (!candidate.startsWith(`${componentsRoot}${path.sep}`)) continue;
    if (candidate.includes(`${path.sep}ui${path.sep}`)) continue;
    if (candidate.includes(`${path.sep}__tests__${path.sep}`)) continue;
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  return null;
};

const expandComponentImports = (
  repoRoot: string,
  scope: PublicUiSourceScope,
  baseFiles: readonly string[],
  reservedOwnerByFile: ReadonlyMap<string, string>,
): string[] => {
  if (!scope.follow_component_imports) return [...baseFiles];
  const found = new Set(baseFiles);
  const queue = [...baseFiles];
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) continue;
    const sourceText = fs.readFileSync(current, "utf8");
    const sourceFile = ts.createSourceFile(
      current,
      sourceText,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX,
    );
    const importSpecifiers = new Set<string>();
    const collectImportSpecifiers = (node: ts.Node): void => {
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
        importSpecifiers.add(node.moduleSpecifier.text);
      } else if (
        ts.isCallExpression(node) &&
        node.expression.kind === ts.SyntaxKind.ImportKeyword &&
        node.arguments.length === 1 &&
        ts.isStringLiteralLike(node.arguments[0])
      ) {
        importSpecifiers.add(node.arguments[0].text);
      }
      ts.forEachChild(node, collectImportSpecifiers);
    };
    collectImportSpecifiers(sourceFile);
    for (const specifier of importSpecifiers) {
      const imported = resolveImportedComponent(repoRoot, current, specifier);
      if (!imported || found.has(imported)) continue;
      const reservedOwner = reservedOwnerByFile.get(imported);
      if (reservedOwner && reservedOwner !== scope.surface_id) continue;
      found.add(imported);
      queue.push(imported);
    }
  }
  return [...found].sort();
};

export const buildHelixPublicUiControlInventory = (
  repoRoot: string,
  scopes: readonly PublicUiSourceScope[] = HELIX_PUBLIC_UI_SOURCE_SCOPES,
): PublicUiControlInventoryEntry[] => {
  const inventory: PublicUiControlInventoryEntry[] = [];
  const baseFilesBySurfaceId = new Map(
    scopes.map((scope) => [scope.surface_id, collectBaseSourceFiles(repoRoot, scope)]),
  );
  const reservedOwnerByFile = new Map<string, string>();
  for (const scope of scopes) {
    for (const sourceFile of baseFilesBySurfaceId.get(scope.surface_id) ?? []) {
      reservedOwnerByFile.set(sourceFile, scope.surface_id);
    }
  }
  for (const scope of scopes) {
    const sourceFiles = expandComponentImports(
      repoRoot,
      scope,
      baseFilesBySurfaceId.get(scope.surface_id) ?? [],
      reservedOwnerByFile,
    );
    for (const absolutePath of sourceFiles) {
      const sourceText = fs.readFileSync(absolutePath, "utf8");
      const sourceFile = ts.createSourceFile(
        absolutePath,
        sourceText,
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TSX,
      );
      const relativePath = normalizePath(path.relative(repoRoot, absolutePath));
      const visit = (node: ts.Node): void => {
        const opening = ts.isJsxElement(node)
          ? node.openingElement
          : ts.isJsxSelfClosingElement(node)
            ? node
            : undefined;
        if (opening) {
          const tagName = opening.tagName.getText();
          if (isInteractive(tagName, opening.attributes)) {
            const line = sourceFile.getLineAndCharacterOfPosition(opening.getStart()).line + 1;
            const helixControlId = readStringAttribute(opening.attributes, "data-helix-control-id");
            const testId = readStringAttribute(opening.attributes, "data-testid");
            const id = readStringAttribute(opening.attributes, "id");
            const ariaLabel = readStringAttribute(opening.attributes, "aria-label");
            const name = readStringAttribute(opening.attributes, "name");
            const title = readStringAttribute(opening.attributes, "title");
            const placeholder = readStringAttribute(opening.attributes, "placeholder");
            const value = readStringAttribute(opening.attributes, "value");
            const label = ts.isJsxElement(node) ? collectTextLabel(node) : undefined;
            const handler =
              readExpressionAttribute(opening.attributes, "onClick") ??
              readExpressionAttribute(opening.attributes, "onSubmit");
            const locatorChoice = helixControlId
              ? (["helix_control_id", helixControlId] as const)
              : testId
              ? (["test_id", testId] as const)
              : id
                ? (["id", id] as const)
              : ariaLabel
                ? (["aria_label", ariaLabel] as const)
                : name
                  ? (["name", name] as const)
                  : title
                    ? (["title", title] as const)
                    : placeholder
                      ? (["placeholder", placeholder] as const)
                      : value
                        ? (["value", value] as const)
                  : label
                    ? (["label", label] as const)
                    : handler
                      ? (["handler", handler] as const)
                      : (["line", String(line)] as const);
            const authority = inferAuthority(opening.attributes, scope.default_authority_state);
            const locator = locatorChoice[1].replace(/\s+/g, " ").slice(0, 160);
            inventory.push({
              schema: "helix.public_ui_control.v1",
              control_id: `${scope.surface_id}:${relativePath}:line:${line}:${tagName}`,
              surface_id: scope.surface_id,
              account_scope: scope.account_scope,
              source_path: relativePath,
              line,
              element: tagName,
              locator_kind: locatorChoice[0],
              locator,
              interaction_kind: inferInteractionKind(tagName, opening.attributes),
              ...authority,
              needs_explicit_semantic_id: !helixControlId && !testId && !id && !ariaLabel && !name,
              interaction_classification_source: hasExplicitInteractionKind(opening.attributes)
                ? "explicit"
                : "mechanical_default",
            });
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(sourceFile);
    }
  }
  return inventory.sort((left, right) => left.control_id.localeCompare(right.control_id));
};
