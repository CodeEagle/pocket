import { createStore } from "./store.ts";
import type { Toasts } from "./toasts.ts";
import { errorText } from "./workspace.ts";
import type { ProjectInfo, StudioClient } from "../studio-client.ts";

export interface ProjectDraft { template: "app" | "game"; id: string; name: string; appId: string }
export interface ProjectsState {
  list: ProjectInfo[];
  loaded: boolean;
  current?: string;
  createOpen: boolean;
  draft: ProjectDraft;
}

export function createProjects(deps: {
  client: StudioClient;
  toasts: Toasts;
  /** Runs before the current project is replaced; false cancels the switch (unsaved changes prompt). */
  confirmLeave: () => Promise<boolean>;
  /** Runs once the project is chosen: load files, attach build, reset preview. */
  onOpen: (project: string) => Promise<void>;
  onOpened?: () => void;
}) {
  const { client, toasts } = deps;
  const store = createStore<ProjectsState>({
    list: [], loaded: false, createOpen: false,
    draft: { template: "app", id: "my-pocket-app", name: "我的 Pocket 应用", appId: "pocket.app" },
  });
  const state = () => store.get();

  async function refresh(): Promise<void> {
    try {
      store.update({ list: await client.project.list(), loaded: true });
    } catch (error) {
      store.update({ loaded: true });
      toasts.error(errorText(error));
    }
  }

  async function open(id: string): Promise<boolean> {
    if (state().current && state().current !== id && !(await deps.confirmLeave())) return false;
    if (state().current === id) { deps.onOpened?.(); return true; }
    try {
      store.update({ current: id });
      await deps.onOpen(id);
      deps.onOpened?.();
      return true;
    } catch (error) {
      toasts.error(errorText(error));
      return false;
    }
  }

  async function create(): Promise<void> {
    const d = state().draft;
    try {
      const created = await client.project.create(d.id, d.template, { name: d.name, appId: d.appId });
      store.update({ createOpen: false });
      await refresh();
      toasts.success(`已创建项目 ${created.id}`);
      await open(created.id);
    } catch (error) {
      toasts.error(errorText(error));
    }
  }

  return {
    store, state, refresh, open, create,
    setCreateOpen: (createOpen: boolean) => store.update({ createOpen }),
    setDraft: (draft: ProjectDraft) => store.update({ draft }),
    current: () => state().current,
  };
}
export type Projects = ReturnType<typeof createProjects>;
