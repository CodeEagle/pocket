// A tiny observable store. State modules are plain TypeScript (no Solid
// import) so bun unit tests can run them with fakes; the UI binds them to
// Solid signals in `ui/bind.ts`.
export type Listener = () => void;

export interface Store<T> {
  get(): T;
  set(next: T): void;
  update(patch: Partial<T>): void;
  subscribe(listener: Listener): () => void;
}

export function createStore<T extends object>(initial: T): Store<T> {
  let state = initial;
  const listeners = new Set<Listener>();
  const notify = (): void => { for (const listener of [...listeners]) listener(); };
  return {
    get: () => state,
    set(next) { state = next; notify(); },
    update(patch) { state = { ...state, ...patch }; notify(); },
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
}
