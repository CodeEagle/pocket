// Studio shell state. All policy lives here in JS; the Dart host only
// forwards the frozen studio.* capabilities.
import { createMemo, createSignal } from "solid-js";
import { buildTree, toggled, viewerLines, visibleRows, type TreeRow } from "./tree.ts";
import type { ProjectInfo, StudioClient } from "./studio-client.ts";

export type StudioPage = "projects" | "source" | "console" | "resources" | "settings" | "versions";
export const MAX_VIEW_BYTES = 512 * 1024;

export function errorText(error: unknown): string {
  const e = error as { code?: string; message?: string };
  return e?.message ? `${e.code ? `${e.code}: ` : ""}${e.message}` : String(error);
}

export function createStudioModel(client: StudioClient) {
  const [page, setPage] = createSignal<StudioPage>("projects");
  const [projects, setProjects] = createSignal<ProjectInfo[]>([]);
  const [loaded, setLoaded] = createSignal(false);
  const [notice, setNotice] = createSignal("");
  const [current, setCurrent] = createSignal<string | undefined>(undefined);
  const [files, setFiles] = createSignal<{ path: string; bytes: number }[]>([]);
  const [expanded, setExpanded] = createSignal<ReadonlySet<string>>(new Set<string>());
  const [selected, setSelected] = createSignal<string | undefined>(undefined);
  const [viewer, setViewer] = createSignal<{ text: string; bytes: number } | undefined>(undefined);
  const [dialogOpen, setDialogOpen] = createSignal(false);
  const [draft, setDraft] = createSignal({ template: "app" as "app" | "game", id: "my-pocket-app", name: "我的 Pocket 应用", appId: "pocket.app" });

  const tree = createMemo(() => buildTree(files()));
  const rows = createMemo<TreeRow[]>(() => visibleRows(tree(), expanded()));
  const currentProject = createMemo(() => projects().find((p) => p.id === current()));
  const viewerView = createMemo(() => {
    const v = viewer();
    return v ? viewerLines(v.text) : undefined;
  });

  async function guard<T>(work: () => Promise<T>): Promise<T | undefined> {
    try {
      setNotice("");
      return await work();
    } catch (error) {
      setNotice(errorText(error));
      return undefined;
    }
  }

  const refreshProjects = () => guard(async () => {
    setProjects(await client.project.list());
    setLoaded(true);
  });

  const loadTree = (project: string) => guard(async () => {
    const result = await client.fs.tree(project);
    setFiles(result.files);
  });

  const openProject = (id: string) => guard(async () => {
    setCurrent(id);
    setSelected(undefined);
    setViewer(undefined);
    setExpanded(new Set<string>());
    setPage("source");
    await loadTree(id);
  });

  const toggleFolder = (path: string) => setExpanded(toggled(expanded(), path));

  const selectFile = (path: string) => guard(async () => {
    const project = current();
    if (!project) return;
    setSelected(path);
    setViewer(undefined);
    const entry = files().find((f) => f.path === path);
    if (entry && entry.bytes > MAX_VIEW_BYTES) {
      setViewer({ text: `文件过大（${entry.bytes} 字节），只读查看器不显示超过 ${MAX_VIEW_BYTES} 字节的文件。`, bytes: entry.bytes });
      return;
    }
    const result = await client.fs.readText(project, path, MAX_VIEW_BYTES);
    setViewer({ text: result.text, bytes: result.bytes });
  });

  const createProject = () => guard(async () => {
    const d = draft();
    const created = await client.project.create(d.id, d.template, { name: d.name, appId: d.appId });
    setDialogOpen(false);
    await refreshProjects();
    await openProject(created.id);
  });

  return {
    page, setPage, projects, loaded, notice, setNotice, current, currentProject, rows, selected, viewer, viewerView,
    dialogOpen, setDialogOpen, draft, setDraft,
    refreshProjects, openProject, toggleFolder, selectFile, createProject,
  };
}
export type StudioModel = ReturnType<typeof createStudioModel>;
