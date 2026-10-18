export function collectIdeologyNodeIdsFromTree(tree: unknown): Set<string> {
  const nodeIds = new Set<string>();

  if (tree && typeof tree === "object") {
    const nodes = (tree as { nodes?: unknown }).nodes;
    if (Array.isArray(nodes)) {
      for (const node of nodes) {
        if (!node || typeof node !== "object") continue;
        const nodeId = (node as { id?: unknown }).id;
        if (typeof nodeId === "string" && nodeId.length > 0) {
          nodeIds.add(nodeId);
        }
      }
      if (nodeIds.size > 0) {
        return nodeIds;
      }
    }
  }

  function walk(obj: any) {
    if (!obj || typeof obj !== "object") return;

    // ideology.json may be keyed by nodeId: { children: { ... } }
    for (const [key, value] of Object.entries(obj)) {
      if (typeof key === "string" && value && typeof value === "object") {
        nodeIds.add(key);

        const children = (value as any).children;
        if (children && typeof children === "object") {
          walk(children);
        }
      }
    }
  }

  walk(tree);
  return nodeIds;
}
