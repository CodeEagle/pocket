// One modal at a time. Callers await the user's choice.
import { createStore } from "./store.ts";

export interface DialogChoice { id: string; label: string; danger?: boolean }
export interface DialogRequest {
  title: string;
  body?: string;
  /** Extra buttons, rendered above the cancel/confirm row. */
  choices?: DialogChoice[];
  confirmLabel?: string;
  cancelLabel?: string;
  /** Text prompt: the dialog shows an input with this initial value. */
  input?: { value: string; placeholder?: string; label?: string };
  tone?: "default" | "danger";
}
export interface ActiveDialog extends DialogRequest { id: number; inputValue: string; error?: string }
export type DialogResult = { kind: "confirm"; value: string } | { kind: "choice"; id: string; value: string } | { kind: "cancel" };

export function createDialogs() {
  const store = createStore<{ active: ActiveDialog | undefined }>({ active: undefined });
  let nextId = 1;
  let settle: ((result: DialogResult) => void) | undefined;
  let validate: ((value: string) => string | undefined) | undefined;

  function open(request: DialogRequest, check?: (value: string) => string | undefined): Promise<DialogResult> {
    // A new modal replaces the current one; the displaced caller sees a cancel.
    settle?.({ kind: "cancel" });
    validate = check;
    return new Promise<DialogResult>((resolve) => {
      settle = resolve;
      store.set({ active: { ...request, id: nextId++, inputValue: request.input?.value ?? "" } });
    });
  }
  const finish = (result: DialogResult): void => {
    const done = settle;
    settle = undefined;
    validate = undefined;
    store.set({ active: undefined });
    done?.(result);
  };

  return {
    store,
    active: () => store.get().active,
    open,
    /** Yes/no. */
    async confirm(request: DialogRequest): Promise<boolean> { return (await open(request)).kind === "confirm"; },
    /** Text prompt; resolves to the entered text or undefined when cancelled. `check` returns an error message to keep it open. */
    async prompt(request: DialogRequest & { input: NonNullable<DialogRequest["input"]> }, check?: (value: string) => string | undefined): Promise<string | undefined> {
      const result = await open(request, check);
      return result.kind === "confirm" ? result.value : undefined;
    },
    setInput(value: string): void {
      const active = store.get().active;
      if (active) store.set({ active: { ...active, inputValue: value, error: undefined } });
    },
    confirmActive(): void {
      const active = store.get().active;
      if (!active) return;
      const problem = active.input ? validate?.(active.inputValue) : undefined;
      if (problem) { store.set({ active: { ...active, error: problem } }); return; }
      finish({ kind: "confirm", value: active.inputValue });
    },
    choose(id: string): void {
      const active = store.get().active;
      if (active) finish({ kind: "choice", id, value: active.inputValue });
    },
    cancel(): void { if (store.get().active) finish({ kind: "cancel" }); },
  };
}
export type Dialogs = ReturnType<typeof createDialogs>;
