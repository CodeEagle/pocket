// Studio-local settings. They persist through the SystemUI storage capability
// (`system.storage.*`, scoped to the Studio app id by the host); there is no
// Dart-side settings state. If storage is unavailable the settings still work
// for the session and the page says they are not persisted.
import { createStore } from "./store.ts";
import type { Toasts } from "./toasts.ts";
import { errorText } from "./workspace.ts";

export interface SettingsBackend {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
}

export interface StudioSettings {
  /** Save -> build -> preview publish -> child reload, automatically. */
  autoBuild: boolean;
  /** Quiet time after the last save before the automatic build starts. */
  debounceMs: number;
  /** Show the live preview beside the editor instead of only on the Preview page. */
  dockPreview: boolean;
  /** Editor widget: "code" is the CodeView (default since M4); "input" is the M2 multi-line InputField fallback. */
  editor: "input" | "code";
}
export interface SettingsState extends StudioSettings { loaded: boolean; persistence: "unknown" | "ok" | "unavailable" }

export const SETTINGS_KEY = "studio.settings.v1";
export const DEFAULT_SETTINGS: StudioSettings = { autoBuild: false, debounceMs: 800, dockPreview: true, editor: "code" };
export const DEBOUNCE_CHOICES: readonly number[] = [300, 800, 2000];

export function parseSettings(value: unknown): StudioSettings {
  const r = value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const debounce = typeof r.debounceMs === "number" && Number.isFinite(r.debounceMs) ? Math.min(10000, Math.max(0, Math.floor(r.debounceMs))) : DEFAULT_SETTINGS.debounceMs;
  return {
    autoBuild: r.autoBuild === true,
    debounceMs: debounce,
    dockPreview: r.dockPreview === false ? false : DEFAULT_SETTINGS.dockPreview,
    // Stored settings from M2/M3 have no (or "input") editor: absent migrates to the new default, an explicit choice stays.
    editor: r.editor === "input" ? "input" : "code",
  };
}

export function createSettings(deps: { backend: SettingsBackend; toasts: Toasts }) {
  const { backend, toasts } = deps;
  const store = createStore<SettingsState>({ ...DEFAULT_SETTINGS, loaded: false, persistence: "unknown" });
  let warned = false;

  async function load(): Promise<void> {
    try {
      const value = await backend.get(SETTINGS_KEY);
      store.update({ ...parseSettings(value), loaded: true, persistence: "ok" });
    } catch {
      store.update({ loaded: true, persistence: "unavailable" });
    }
  }

  async function set(patch: Partial<StudioSettings>): Promise<void> {
    const next = parseSettings({ ...store.get(), ...patch });
    store.update(next);
    try {
      await backend.set(SETTINGS_KEY, next);
      store.update({ persistence: "ok" });
    } catch (error) {
      store.update({ persistence: "unavailable" });
      if (!warned) { warned = true; toasts.warning(`设置仅在本次会话生效（无法保存：${errorText(error)}）`); }
    }
  }

  return { store, get: () => store.get(), load, set };
}
export type Settings = ReturnType<typeof createSettings>;
