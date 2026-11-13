// Bridges a plain Store to a Solid accessor. Only UI modules import this.
import { createSignal, onCleanup, type Accessor } from "solid-js";
import type { Store } from "../state/store.ts";

export function fromStore<T extends object>(store: Store<T>): Accessor<T> {
  const [value, setValue] = createSignal<T>(store.get(), { equals: false });
  const unsubscribe = store.subscribe(() => setValue(() => store.get()));
  onCleanup(unsubscribe);
  return value;
}

/** Accessor for one derived field; only notifies when the selected value changes. */
export function select<T extends object, R>(store: Store<T>, pick: (state: T) => R): Accessor<R> {
  const [value, setValue] = createSignal<R>(pick(store.get()));
  const unsubscribe = store.subscribe(() => setValue(() => pick(store.get())));
  onCleanup(unsubscribe);
  return value;
}
