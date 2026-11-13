// Project-relative path helpers. The service enforces the real policy; these
// give early, readable errors in the dialogs.
export const EDITABLE_EXTENSIONS = ["ts", "tsx", "js", "jsx", "json", "svg", "css", "md"] as const;
export const PROTECTED_SEGMENTS = ["assets", "builds", "updates", "keys", "node_modules", "build", "dist", "out", ".git", ".pocket-build"] as const;

export const dirname = (path: string): string => { const i = path.lastIndexOf("/"); return i < 0 ? "" : path.slice(0, i); };
export const basename = (path: string): string => path.slice(path.lastIndexOf("/") + 1);
export const join = (dir: string, name: string): string => (dir ? `${dir}/${name}` : name);
export const extension = (path: string): string => { const n = basename(path); const i = n.lastIndexOf("."); return i < 0 ? "" : n.slice(i + 1).toLowerCase(); };
export const isEditablePath = (path: string): boolean => (EDITABLE_EXTENSIONS as readonly string[]).includes(extension(path));

/** Returns a message when `path` is not an acceptable new project-relative path. */
export function validateNewPath(path: string, kind: "file" | "directory"): string | undefined {
  const trimmed = path.trim();
  if (!trimmed) return "请输入名称";
  if (trimmed.startsWith("/") || trimmed.includes("\\")) return "请使用项目内的相对路径";
  if (trimmed.length > 240) return "路径过长";
  for (const segment of trimmed.split("/")) {
    if (!segment) return "路径包含空的层级";
    if (segment === "." || segment === "..") return "路径不能包含 . 或 ..";
    if (segment.startsWith(".")) return "不允许以 . 开头的名称";
    if ((PROTECTED_SEGMENTS as readonly string[]).includes(segment)) return `“${segment}”是受保护的目录名`;
    if (/[\u0000-\u001f<>:"|?*]/.test(segment)) return "名称包含不支持的字符";
  }
  if (kind === "file" && !isEditablePath(trimmed)) return `仅支持 ${EDITABLE_EXTENSIONS.join("、")} 文件`;
  return undefined;
}

/** True when `path` equals `folder` or lies below it. */
export const isInside = (folder: string, path: string): boolean => path === folder || path.startsWith(`${folder}/`);
