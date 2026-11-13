// Quick-open (Cmd+P): a fuzzy file finder over the project's editable files. The overlay UI is
// components/quick-open.tsx; this store owns query, ranking and selection so it is testable without a screen.
import { createStore } from "./store.ts";
import { fuzzyFilter, type FuzzyMatch } from "../lib/fuzzy.ts";

export const QUICK_OPEN_LIMIT = 50;

export interface QuickOpenState { open: boolean; query: string; selected: number; results: FuzzyMatch[] }

export function createQuickOpen(deps: {
  paths: () => readonly string[];
  /** Most recently used documents first (open tabs, active first). */
  recent: () => readonly string[];
  openFile: (path: string) => Promise<void>;
  /** Runs after a file was chosen (the shell shows the Source page). */
  onChosen?: (path: string) => void;
}) {
  const store = createStore<QuickOpenState>({ open: false, query: "", selected: 0, results: [] });
  const state = () => store.get();
  const rank = (query: string): FuzzyMatch[] => fuzzyFilter(deps.paths(), query, { limit: QUICK_OPEN_LIMIT, recent: deps.recent() });

  function show(): void { store.set({ open: true, query: "", selected: 0, results: rank("") }); }
  function hide(): void { if (state().open) store.set({ open: false, query: "", selected: 0, results: [] }); }
  function toggle(): void { if (state().open) hide(); else show(); }
  function setQuery(query: string): void { if (state().open) store.update({ query, selected: 0, results: rank(query) }); }
  function move(step: number): void {
    const n = state().results.length;
    if (n === 0) return;
    store.update({ selected: (((state().selected + step) % n) + n) % n });
  }
  /** Opens the selected (or the given) result and closes the finder. Resolves false when there is nothing to open. */
  async function accept(index: number = state().selected): Promise<boolean> {
    const match = state().results[index];
    if (!match) return false;
    hide();
    await deps.openFile(match.path);
    deps.onChosen?.(match.path);
    return true;
  }
  return { store, state, show, hide, toggle, setQuery, move, accept, isOpen: () => state().open };
}
export type QuickOpen = ReturnType<typeof createQuickOpen>;
