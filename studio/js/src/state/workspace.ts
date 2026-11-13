// Files, tabs, dirty state, save, tree operations and the fs.watch reconciler.
// All policy is here in JS; the Dart provider only forwards studio.fs.* calls.
import { createStore } from "./store.ts";
import { openResilient, type ConnectionState } from "./resilient.ts";
import type { Timers } from "./env.ts";
import type { Toasts } from "./toasts.ts";
import type { Dialogs } from "./dialogs.ts";
import { StudioError, type FileEntry, type StudioClient, type WatchEvent } from "../studio-client.ts";
import { basename, dirname, isInside, join, validateNewPath } from "../lib/path.ts";

/** InputField editor cap. The Pocket-native CodeView (M4) lifts it. */
export const MAX_EDIT_BYTES = 1024 * 1024;

export function errorText(error: unknown): string {
  const e = error as { code?: string; message?: string };
  return e?.message ? `${e.code ? `${e.code}: ` : ""}${e.message}` : String(error);
}

export interface JumpTarget { line: number; column: number; seq: number }
export interface Doc {
  path: string;
  /** Current editor text. */
  text: string;
  /** Last text known to be on disk. `text !== saved` means dirty. */
  saved: string;
  bytes: number;
  status: "loading" | "ready" | "blocked" | "error";
  message?: string;
  saving: boolean;
  conflict?: { kind: "changed" | "deleted"; theirs?: string };
  jump?: JumpTarget;
}
export interface AssetInfo { name: string; path: string; bytes?: number; mtimeMs?: number; error?: string }

export interface WorkspaceState {
  project?: string;
  files: FileEntry[];
  assets: string[];
  /** Folders without files yet (the service's flat list cannot show them). */
  emptyFolders: string[];
  revision: number;
  treeLoading: boolean;
  expanded: ReadonlySet<string>;
  selected?: string;
  selectedKind?: "file" | "directory";
  docs: Doc[];
  active?: string;
  watch: ConnectionState | "off";
  asset?: AssetInfo;
}

export interface WorkspaceDeps {
  client: StudioClient;
  toasts: Toasts;
  dialogs: Dialogs;
  timers: Timers;
}

export const isDirty = (doc: Doc): boolean => doc.status === "ready" && doc.text !== doc.saved;

export function createWorkspace(deps: WorkspaceDeps) {
  const { client, toasts, dialogs, timers } = deps;
  const store = createStore<WorkspaceState>({
    files: [], assets: [], emptyFolders: [], revision: 0, treeLoading: false, expanded: new Set<string>(), docs: [], watch: "off",
  });
  const savedListeners = new Set<(path: string) => void>();
  let watcher: { close(): void } | undefined;
  let jumpSeq = 0;
  // Per-load token: results that arrive after the project changed are dropped.
  let epoch = 0;

  const state = () => store.get();
  const projectId = () => state().project;
  const docOf = (path: string): Doc | undefined => state().docs.find((d) => d.path === path);
  function patchDoc(path: string, patch: Partial<Doc>): void {
    store.update({ docs: state().docs.map((d) => (d.path === path ? { ...d, ...patch } : d)) });
  }
  function removeEmptyFoldersCovered(files: FileEntry[], folders: string[]): string[] {
    return folders.filter((folder) => !files.some((f) => isInside(folder, f.path)));
  }
  const fail = (what: string, error: unknown): void => { toasts.error(`${what}：${errorText(error)}`); };

  // ---- tree -------------------------------------------------------------
  async function refreshTree(): Promise<void> {
    const project = projectId();
    if (!project) return;
    const mine = epoch;
    try {
      const result = await client.fs.tree(project, true);
      if (mine !== epoch) return;
      store.update({
        files: result.files, assets: result.assets ?? [], revision: result.revision, treeLoading: false,
        emptyFolders: removeEmptyFoldersCovered(result.files, state().emptyFolders),
      });
    } catch (error) {
      if (mine !== epoch) return;
      store.update({ treeLoading: false });
      fail("无法读取文件列表", error);
    }
  }

  async function load(project: string): Promise<void> {
    unload();
    epoch += 1;
    store.set({
      files: [], assets: [], emptyFolders: [], revision: 0, treeLoading: true, expanded: new Set<string>(), docs: [], watch: "off", project,
    });
    await refreshTree();
    startWatch(project);
  }

  function unload(): void {
    watcher?.close();
    watcher = undefined;
    epoch += 1;
    flushTimer?.();
    flushTimer = undefined;
    pending.paths.clear();
    store.set({ files: [], assets: [], emptyFolders: [], revision: 0, treeLoading: false, expanded: new Set<string>(), docs: [], watch: "off" });
  }

  function toggleFolder(path: string): void {
    const next = new Set(state().expanded);
    if (next.has(path)) next.delete(path); else next.add(path);
    store.update({ expanded: next, selected: path, selectedKind: "directory" });
  }
  function expandTo(path: string): void {
    const next = new Set(state().expanded);
    for (let dir = dirname(path); dir; dir = dirname(dir)) next.add(dir);
    store.update({ expanded: next });
  }

  // ---- documents --------------------------------------------------------
  async function open(path: string, jump?: { line: number; column: number }): Promise<void> {
    const project = projectId();
    if (!project) return;
    const target = jump ? { line: jump.line, column: jump.column, seq: ++jumpSeq } : undefined;
    expandTo(path);
    const existing = docOf(path);
    if (existing) {
      store.update({ active: path, selected: path, selectedKind: "file" });
      if (target) patchDoc(path, { jump: target });
      return;
    }
    const entry = state().files.find((f) => f.path === path);
    const base: Doc = { path, text: "", saved: "", bytes: entry?.bytes ?? 0, status: "loading", saving: false, ...(target ? { jump: target } : {}) };
    store.update({ docs: [...state().docs, base], active: path, selected: path, selectedKind: "file" });
    if (entry && entry.bytes > MAX_EDIT_BYTES) {
      patchDoc(path, {
        status: "blocked",
        message: `文件为 ${Math.ceil(entry.bytes / 1024)} KiB，超过当前 InputField 编辑器的 ${MAX_EDIT_BYTES / 1024} KiB 上限。Pocket 原生代码编辑器（CodeView）将解除此限制。`,
      });
      return;
    }
    const mine = epoch;
    try {
      const read = await client.fs.readText(project, path, MAX_EDIT_BYTES, entry?.bytes);
      if (mine !== epoch || !docOf(path)) return;
      patchDoc(path, { text: read.text, saved: read.text, bytes: read.bytes, status: "ready" });
    } catch (error) {
      if (mine !== epoch || !docOf(path)) return;
      const tooLarge = error instanceof StudioError && error.code === "too_large";
      patchDoc(path, {
        status: tooLarge ? "blocked" : "error",
        message: tooLarge ? `文件超过 ${MAX_EDIT_BYTES / 1024} KiB 的编辑上限。` : errorText(error),
      });
      if (!tooLarge) fail(`无法打开 ${path}`, error);
    }
  }

  function setText(path: string, text: string): void {
    const doc = docOf(path);
    if (!doc || doc.status !== "ready" || doc.text === text) return;
    patchDoc(path, { text });
  }

  function activate(path: string): void {
    if (docOf(path)) store.update({ active: path, selected: path, selectedKind: "file" });
  }

  const dirtyDocs = (): Doc[] => state().docs.filter(isDirty);

  async function save(path: string | undefined = state().active): Promise<boolean> {
    const project = projectId();
    const doc = path ? docOf(path) : undefined;
    if (!project || !path || !doc || doc.status !== "ready" || doc.saving) return false;
    if (doc.conflict) {
      const overwrite = await dialogs.confirm({
        title: "覆盖磁盘上的更改？",
        body: doc.conflict.kind === "deleted" ? `${path} 已在磁盘上被删除。保存会重新创建它。` : `${path} 在磁盘上已被外部修改。保存会覆盖那些更改。`,
        confirmLabel: "覆盖保存", cancelLabel: "取消", tone: "danger",
      });
      if (!overwrite) return false;
    }
    const text = docOf(path)?.text ?? doc.text;
    patchDoc(path, { saving: true });
    const mine = epoch;
    try {
      const result = await client.fs.writeText(project, path, text);
      if (mine !== epoch) return true;
      patchDoc(path, { saved: text, bytes: result.bytes, saving: false, conflict: undefined });
      store.update({ revision: result.revision, files: upsertFile(state().files, path, result.bytes) });
      toasts.success(`已保存 ${path}`);
      for (const listener of [...savedListeners]) listener(path);
      return true;
    } catch (error) {
      if (mine === epoch) patchDoc(path, { saving: false });
      fail(`保存 ${path} 失败`, error);
      return false;
    } finally {
      // A watch event that arrived while the write was in flight was deferred.
      if (mine === epoch && reconcileAgain.delete(path) && docOf(path)) void reconcile(path);
    }
  }

  async function saveAll(): Promise<boolean> {
    let ok = true;
    for (const doc of dirtyDocs()) ok = (await save(doc.path)) && ok;
    return ok;
  }

  function dropDoc(path: string): void {
    const docs = state().docs;
    const index = docs.findIndex((d) => d.path === path);
    if (index < 0) return;
    const next = docs.filter((d) => d.path !== path);
    const active = state().active === path ? next[Math.min(index, next.length - 1)]?.path : state().active;
    store.update({ docs: next, active });
  }

  /** Closes a tab; a dirty tab asks first. Resolves false when the user cancelled or saving failed. */
  async function close(path: string): Promise<boolean> {
    const doc = docOf(path);
    if (!doc) return true;
    if (isDirty(doc)) {
      const result = await dialogs.open({
        title: "关闭前保存更改？", body: `${path} 有未保存的更改。`, confirmLabel: "保存", cancelLabel: "取消",
        choices: [{ id: "discard", label: "不保存", danger: true }],
      });
      if (result.kind === "cancel") return false;
      if (result.kind === "confirm" && !(await save(path))) return false;
    }
    dropDoc(path);
    return true;
  }

  /** Used before switching or closing a project: resolves true when it is safe to discard the open tabs. */
  async function confirmLeave(): Promise<boolean> {
    const dirty = dirtyDocs();
    if (dirty.length === 0) return true;
    const names = dirty.slice(0, 4).map((d) => d.path).join("、") + (dirty.length > 4 ? ` 等 ${dirty.length} 个文件` : "");
    const result = await dialogs.open({
      title: "有未保存的更改", body: `${names} 有未保存的更改。`, confirmLabel: "保存全部并继续", cancelLabel: "取消",
      choices: [{ id: "discard", label: "不保存，继续", danger: true }],
    });
    if (result.kind === "cancel") return false;
    if (result.kind === "confirm") return saveAll();
    return true;
  }

  function resolveConflict(path: string, side: "mine" | "theirs"): void {
    const doc = docOf(path);
    if (!doc?.conflict) return;
    if (side === "theirs") {
      const theirs = doc.conflict.theirs;
      if (theirs === undefined) { dropDoc(path); return; } // deleted on disk: nothing to reload
      patchDoc(path, { text: theirs, saved: theirs, bytes: theirs.length, conflict: undefined });
    } else {
      // Keep mine: disk content is now the baseline, so the tab stays dirty and a save overwrites it.
      patchDoc(path, { saved: doc.conflict.theirs ?? "\u0000deleted", conflict: undefined });
    }
  }

  // ---- tree operations --------------------------------------------------
  const exists = (path: string): boolean => state().files.some((f) => f.path === path) || state().emptyFolders.includes(path) || state().files.some((f) => isInside(path, f.path));

  async function createFile(dir = ""): Promise<void> {
    const project = projectId();
    if (!project) return;
    const name = await dialogs.prompt(
      { title: "新建文件", body: `位置：${dir || "项目根目录"}`, input: { value: "", placeholder: "components/button.tsx" }, confirmLabel: "创建", cancelLabel: "取消" },
      (value) => validateNewPath(join(dir, value.trim()), "file") ?? (exists(join(dir, value.trim())) ? "已存在同名文件或文件夹" : undefined),
    );
    if (name === undefined) return;
    const path = join(dir, name.trim());
    try {
      await client.fs.writeText(project, path, "");
      await refreshTree();
      await open(path);
      toasts.success(`已创建 ${path}`);
    } catch (error) { fail("创建文件失败", error); }
  }

  async function createFolder(dir = ""): Promise<void> {
    const project = projectId();
    if (!project) return;
    const name = await dialogs.prompt(
      { title: "新建文件夹", body: `位置：${dir || "项目根目录"}`, input: { value: "", placeholder: "components" }, confirmLabel: "创建", cancelLabel: "取消" },
      (value) => validateNewPath(join(dir, value.trim()), "directory") ?? (exists(join(dir, value.trim())) ? "已存在同名文件或文件夹" : undefined),
    );
    if (name === undefined) return;
    const path = join(dir, name.trim());
    try {
      await client.fs.mkdir(project, path);
      store.update({ emptyFolders: [...state().emptyFolders, path] });
      const next = new Set(state().expanded);
      next.add(path);
      for (let d = dirname(path); d; d = dirname(d)) next.add(d);
      store.update({ expanded: next, selected: path, selectedKind: "directory" });
      await refreshTree();
      toasts.success(`已创建文件夹 ${path}`);
    } catch (error) { fail("创建文件夹失败", error); }
  }

  async function rename(path: string): Promise<void> {
    const project = projectId();
    if (!project) return;
    if (!state().files.some((f) => f.path === path)) {
      toasts.warning("暂不支持重命名文件夹：服务只提供文件移动。");
      return;
    }
    const to = await dialogs.prompt(
      { title: "重命名 / 移动", body: path, input: { value: path }, confirmLabel: "确定", cancelLabel: "取消" },
      (value) => {
        const next = value.trim();
        if (next === path) return "名称没有变化";
        return validateNewPath(next, "file") ?? (exists(next) ? "目标已存在" : undefined);
      },
    );
    if (to === undefined) return;
    const target = to.trim();
    try {
      await client.fs.rename(project, path, target);
      const doc = docOf(path);
      if (doc) {
        store.update({
          docs: state().docs.map((d) => (d.path === path ? { ...d, path: target } : d)),
          active: state().active === path ? target : state().active,
        });
      }
      store.update({ selected: target, selectedKind: "file" });
      expandTo(target);
      await refreshTree();
      toasts.success(`已移动到 ${target}`);
    } catch (error) { fail("重命名失败", error); }
  }

  async function remove(path: string): Promise<void> {
    const project = projectId();
    if (!project) return;
    const isFile = state().files.some((f) => f.path === path);
    const hasChildren = !isFile && state().files.some((f) => isInside(path, f.path));
    if (hasChildren) { toasts.warning("文件夹不为空：请先删除其中的文件。"); return; }
    const dirty = isFile && docOf(path) ? isDirty(docOf(path)!) : false;
    const yes = await dialogs.confirm({
      title: isFile ? "删除文件？" : "删除文件夹？",
      body: `${path}${dirty ? "\n该文件有未保存的更改，将一并丢失。" : ""}`,
      confirmLabel: "删除", cancelLabel: "取消", tone: "danger",
    });
    if (!yes) return;
    try {
      if (isFile) { await client.fs.delete(project, path); dropDoc(path); }
      else {
        await client.fs.rmdir(project, path);
        store.update({ emptyFolders: state().emptyFolders.filter((f) => f !== path) });
      }
      if (state().selected === path) store.update({ selected: undefined, selectedKind: undefined });
      await refreshTree();
      toasts.success(`已删除 ${path}`);
    } catch (error) { fail("删除失败", error); }
  }

  // ---- assets -----------------------------------------------------------
  async function selectAsset(name: string): Promise<void> {
    const project = projectId();
    if (!project) return;
    const path = `assets/${name}`;
    store.update({ asset: { name, path } });
    try {
      const stat = await client.fs.stat(project, path);
      if (state().asset?.name === name) store.update({ asset: { name, path, bytes: stat.bytes, mtimeMs: stat.mtimeMs } });
    } catch (error) {
      if (state().asset?.name === name) store.update({ asset: { name, path, error: errorText(error) } });
    }
  }

  // ---- watch reconciliation ----------------------------------------------
  const pending = { paths: new Set<string>(), tree: false, all: false };
  let flushTimer: (() => void) | undefined;
  const reconciling = new Set<string>();
  const reconcileAgain = new Set<string>();

  function scheduleFlush(): void {
    if (flushTimer) return;
    flushTimer = timers.after(150, () => { flushTimer = undefined; void flush(); });
  }

  async function flush(): Promise<void> {
    const paths = [...pending.paths];
    const all = pending.all;
    pending.paths.clear();
    pending.all = false;
    pending.tree = false;
    await refreshTree();
    const targets = all ? state().docs.map((d) => d.path) : paths.filter((p) => docOf(p));
    for (const path of targets) await reconcile(path);
  }

  async function reconcile(path: string): Promise<void> {
    const project = projectId();
    const doc = docOf(path);
    if (!project || !doc || doc.status !== "ready") return;
    if (reconciling.has(path)) { reconcileAgain.add(path); return; }
    if (doc.saving) { reconcileAgain.add(path); return; }
    reconciling.add(path);
    const mine = epoch;
    try {
      const entry = state().files.find((f) => f.path === path);
      let disk: { text: string; bytes: number } | undefined;
      try {
        disk = await client.fs.readText(project, path, MAX_EDIT_BYTES, entry?.bytes);
      } catch (error) {
        if (mine !== epoch) return;
        if (error instanceof StudioError && error.code === "not_found") {
          const now = docOf(path);
          if (!now) return;
          if (!isDirty(now)) { dropDoc(path); toasts.warning(`${path} 已在磁盘上被删除，标签已关闭。`); }
          else patchDoc(path, { conflict: { kind: "deleted" } });
        } else if (error instanceof StudioError && error.code === "too_large") {
          toasts.warning(`${path} 在磁盘上增长到超过编辑上限。`);
        }
        return;
      }
      if (mine !== epoch) return;
      const now = docOf(path);
      if (!now || now.status !== "ready" || now.saving) return;
      if (disk.text === now.saved && !now.conflict) return; // our own write, or no net change
      if (disk.text === now.text) { patchDoc(path, { saved: disk.text, bytes: disk.bytes, conflict: undefined }); return; }
      if (now.text === now.saved) patchDoc(path, { text: disk.text, saved: disk.text, bytes: disk.bytes, conflict: undefined }); // clean: reload silently
      else if (disk.text !== now.saved) patchDoc(path, { conflict: { kind: "changed", theirs: disk.text } });
    } finally {
      reconciling.delete(path);
      if (reconcileAgain.delete(path) && docOf(path)) void reconcile(path);
    }
  }

  function onWatchEvent(event: WatchEvent): void {
    switch (event.type) {
      case "change": pending.paths.add(event.path); pending.tree = true; scheduleFlush(); break;
      case "revision": if (event.revision !== state().revision) { pending.tree = true; scheduleFlush(); } break;
      case "gap": pending.all = true; pending.tree = true; scheduleFlush(); break;
      default: break; // "ready" and build events are not interesting here
    }
  }

  function startWatch(project: string): void {
    watcher = openResilient<WatchEvent>({
      timers,
      open: (h) => client.fs.watch(project, h.onEvent, h.onError, h.onEnd),
      onEvent: onWatchEvent,
      onResync: () => { pending.all = true; pending.tree = true; scheduleFlush(); },
      onState: (watch) => { if (projectId() === project) store.update({ watch }); },
    });
  }

  return {
    store, state,
    load, unload, refreshTree, toggleFolder, selectAsset,
    open, activate, setText, save, saveAll, close, confirmLeave, resolveConflict,
    createFile, createFolder, rename, remove,
    reconcile, dirtyDocs, docOf,
    onSaved(listener: (path: string) => void): () => void { savedListeners.add(listener); return () => { savedListeners.delete(listener); }; },
    activeDoc: (): Doc | undefined => (state().active ? docOf(state().active!) : undefined),
    name: basename,
  };
}
export type Workspace = ReturnType<typeof createWorkspace>;

function upsertFile(files: FileEntry[], path: string, bytes: number): FileEntry[] {
  return files.some((f) => f.path === path) ? files.map((f) => (f.path === path ? { ...f, bytes } : f)) : [...files, { path, bytes }];
}
