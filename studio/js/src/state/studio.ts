// Composition root of the Studio state. app.tsx only creates this and renders
// the shell; pages read the sub-stores they need. New milestones add stores
// and pages without changing the shell.
import { createStore } from "./store.ts";
import { createToasts } from "./toasts.ts";
import { createDialogs } from "./dialogs.ts";
import { createWorkspace } from "./workspace.ts";
import { createBuild } from "./build.ts";
import { createPreview, type PreviewRuntime } from "./preview.ts";
import { createDeploy } from "./deploy.ts";
import { createSettings, type SettingsBackend } from "./settings.ts";
import { createProjects } from "./projects.ts";
import { createPublish } from "./publish.ts";
import { createArtifacts } from "./artifacts.ts";
import { createVersions } from "./versions.ts";
import { createCopier } from "./copy.ts";
import { createSelfUpdate, type UpdateBackend } from "./self-update.ts";
import type { UpdateHandoff } from "./update-link.ts";
import type { Timers } from "./env.ts";
import type { StudioClient } from "../studio-client.ts";

export type StudioPage = "projects" | "source" | "console" | "preview" | "resources" | "settings" | "artifacts" | "publish" | "versions";

export interface StudioDeps {
  client: StudioClient;
  timers: Timers;
  runtime: PreviewRuntime;
  settingsBackend: SettingsBackend;
  /** Builds the guest-controlled update backend (M6 self-update) around the Studio's portable UI state; optional. */
  updates?: (handoff: UpdateHandoff) => UpdateBackend;
  /** System clipboard client for the code editor (the guest's `clipboard.*` capability client); optional. */
  clipboard?: { readText(): Promise<string | null>; writeText(text: string): Promise<void> };
}

export function createStudio(deps: StudioDeps) {
  const { client, timers } = deps;
  const nav = createStore<{ page: StudioPage }>({ page: "projects" });
  const toasts = createToasts(timers);
  const dialogs = createDialogs();
  const settings = createSettings({ backend: deps.settingsBackend, toasts });
  const workspace = createWorkspace({ client, toasts, dialogs, timers, editorKind: () => settings.get().editor });
  const build = createBuild({ client, timers, toasts });
  // Switching to the InputField hands each CodeView buffer's text back to its document.
  settings.store.subscribe(() => { if (settings.get().editor !== "code") workspace.releaseEditors(); });
  let projects!: ReturnType<typeof createProjects>;
  const preview = createPreview({ client, runtime: deps.runtime, build, timers, toasts, project: () => projects.current() });
  const deploy = createDeploy({ client, timers, toasts, build, project: () => projects.current() });
  // M5: publish / inspect. Keys stay in the service; these stores only hold public facts.
  const copy = createCopier({ clipboard: deps.clipboard, toasts });
  const versions = createVersions({ client, toasts, project: () => projects.current() });
  const artifacts = createArtifacts({ client, toasts, project: () => projects.current() });
  const publish = createPublish({
    client, timers, toasts, dialogs, build, project: () => projects.current(),
    hasUnsavedEdits: () => workspace.dirtyDocs().length > 0,
    onPublished: () => { void versions.refresh(); },
  });
  // A finished build changes what can be published and what the inspector shows.
  build.onDone(() => {
    if (!projects.current()) return;
    if (publish.state().planState !== "idle") void publish.loadPlan();
    if (artifacts.state().loaded) void artifacts.refresh();
  });
  projects = createProjects({
    client, toasts,
    confirmLeave: () => workspace.confirmLeave(),
    onOpen: async (id) => {
      await preview.reset();
      deploy.reset();
      publish.reset();
      artifacts.reset();
      versions.reset();
      build.attach(id);
      await workspace.load(id);
    },
    onOpened: () => nav.update({ page: "source" }),
  });

  // Auto-build: a save (after a quiet period) triggers build -> publish -> reload.
  let cancelAuto: (() => void) | undefined;
  workspace.onSaved(() => {
    if (!settings.get().autoBuild) return;
    cancelAuto?.();
    const savedAt = timers.now();
    cancelAuto = timers.after(settings.get().debounceMs, () => { cancelAuto = undefined; void preview.run({ build: true, since: savedAt }); });
  });

  // M6: self-update. Only portable UI state crosses an update (the page and the open project); the new guest
  // validates it synchronously and the project is reopened once the project list is back.
  const pages: readonly StudioPage[] = ["projects", "source", "console", "preview", "resources", "settings", "artifacts", "publish", "versions"];
  let restored: { page: StudioPage; project?: string } | undefined;
  const handoff: UpdateHandoff = {
    capture: () => ({ page: nav.get().page, project: projects.current() ?? null }),
    restore: (value) => {
      const v = value as { page?: unknown; project?: unknown } | null;
      if (!v || typeof v !== "object" || Array.isArray(v) || !pages.includes(v.page as StudioPage)) return false;
      if (v.project !== null && v.project !== undefined && (typeof v.project !== "string" || v.project.length > 64)) return false;
      restored = { page: v.page as StudioPage, ...(typeof v.project === "string" ? { project: v.project } : {}) };
      nav.update({ page: restored.page });
      return true;
    },
  };
  const updateBackend = deps.updates?.(handoff);
  const selfUpdate = createSelfUpdate({ backend: updateBackend, toasts });

  void settings.load();
  // Reopen the project only after BOTH the project list and the handoff restore have settled (either can come first).
  void Promise.all([projects.refresh(), Promise.resolve(updateBackend?.ready).catch(() => false)]).then(async () => {
    const back = restored;
    if (back?.project && projects.state().list.some((p) => p.id === back.project)) {
      if (await projects.open(back.project)) nav.update({ page: back.page });
    }
  });

  return {
    nav, page: () => nav.get().page, setPage: (page: StudioPage) => nav.update({ page }),
    toasts, dialogs, workspace, build, settings, preview, deploy, projects,
    publish, artifacts, versions, copy, selfUpdate,
    client, timers, clipboard: deps.clipboard,
  };
}
export type Studio = ReturnType<typeof createStudio>;
