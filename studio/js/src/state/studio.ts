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
import type { Timers } from "./env.ts";
import type { StudioClient } from "../studio-client.ts";

export type StudioPage = "projects" | "source" | "console" | "preview" | "resources" | "settings" | "artifacts" | "publish" | "versions";

export interface StudioDeps {
  client: StudioClient;
  timers: Timers;
  runtime: PreviewRuntime;
  settingsBackend: SettingsBackend;
}

export function createStudio(deps: StudioDeps) {
  const { client, timers } = deps;
  const nav = createStore<{ page: StudioPage }>({ page: "projects" });
  const toasts = createToasts(timers);
  const dialogs = createDialogs();
  const workspace = createWorkspace({ client, toasts, dialogs, timers });
  const build = createBuild({ client, timers, toasts });
  const settings = createSettings({ backend: deps.settingsBackend, toasts });
  let projects!: ReturnType<typeof createProjects>;
  const preview = createPreview({ client, runtime: deps.runtime, build, timers, toasts, project: () => projects.current() });
  const deploy = createDeploy({ client, timers, toasts, build, project: () => projects.current() });
  projects = createProjects({
    client, toasts,
    confirmLeave: () => workspace.confirmLeave(),
    onOpen: async (id) => {
      await preview.reset();
      deploy.reset();
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

  void settings.load();
  void projects.refresh();

  return {
    nav, page: () => nav.get().page, setPage: (page: StudioPage) => nav.update({ page }),
    toasts, dialogs, workspace, build, settings, preview, deploy, projects,
    client, timers,
  };
}
export type Studio = ReturnType<typeof createStudio>;
