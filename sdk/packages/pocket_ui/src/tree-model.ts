// Pure model behind the Tree component (tree.tsx): build a folder tree from a flat
// file list and flatten it into the rows visible for a given expanded-folder set.
// No JSX/Solid imports, so bun unit tests and any state module can use it.
export interface FlatFile { path: string; bytes: number }
export interface TreeNode { name: string; path: string; kind: "file" | "directory"; bytes: number; children: TreeNode[] }
export interface TreeRow { node: TreeNode; depth: number; expanded: boolean }

/** `directories` lists folders that have no files yet (a flat file list cannot show them). */
export function buildTree(files: readonly FlatFile[], directories: readonly string[] = []): TreeNode[] {
  const root: TreeNode = { name: "", path: "", kind: "directory", bytes: 0, children: [] };
  for (const directory of directories) {
    let current = root;
    const parts = directory.split("/").filter(Boolean);
    parts.forEach((part, index) => {
      const path = parts.slice(0, index + 1).join("/");
      let child = current.children.find((c) => c.name === part && c.kind === "directory");
      if (!child) { child = { name: part, path, kind: "directory", bytes: 0, children: [] }; current.children.push(child); }
      current = child;
    });
  }
  for (const file of files) {
    const parts = file.path.split("/").filter(Boolean);
    let current = root;
    parts.forEach((part, index) => {
      const path = parts.slice(0, index + 1).join("/");
      const last = index === parts.length - 1;
      let child = current.children.find((c) => c.name === part && c.kind === (last ? "file" : "directory"));
      if (!child) {
        child = { name: part, path, kind: last ? "file" : "directory", bytes: last ? file.bytes : 0, children: [] };
        current.children.push(child);
      }
      current = child;
    });
  }
  const sort = (nodes: TreeNode[]): void => {
    nodes.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "directory" ? -1 : 1));
    for (const node of nodes) sort(node.children);
  };
  sort(root.children);
  return root.children;
}

export function visibleRows(tree: readonly TreeNode[], expanded: ReadonlySet<string>, depth = 0): TreeRow[] {
  const rows: TreeRow[] = [];
  for (const node of tree) {
    const open = node.kind === "directory" && expanded.has(node.path);
    rows.push({ node, depth, expanded: open });
    if (open) rows.push(...visibleRows(node.children, expanded, depth + 1));
  }
  return rows;
}

/** A copy of `expanded` with `path` added or removed. */
export function toggled(expanded: ReadonlySet<string>, path: string): Set<string> {
  const next = new Set(expanded);
  if (next.has(path)) next.delete(path);
  else next.add(path);
  return next;
}
