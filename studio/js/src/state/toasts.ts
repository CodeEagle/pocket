import { createStore } from "./store.ts";
import type { Timers } from "./env.ts";

export type ToastTone = "info" | "success" | "warning" | "danger";
export interface Toast { id: number; tone: ToastTone; message: string }

const MAX_TOASTS = 4;
const LIFETIME_MS: Record<ToastTone, number> = { info: 3500, success: 3000, warning: 6000, danger: 9000 };

export function createToasts(timers: Timers) {
  const store = createStore<{ items: Toast[] }>({ items: [] });
  let nextId = 1;
  const cancels = new Map<number, () => void>();

  function dismiss(id: number): void {
    cancels.get(id)?.();
    cancels.delete(id);
    store.update({ items: store.get().items.filter((toast) => toast.id !== id) });
  }

  function push(tone: ToastTone, message: string): number {
    const text = message.length > 400 ? `${message.slice(0, 400)}…` : message;
    const existing = store.get().items.find((toast) => toast.tone === tone && toast.message === text);
    if (existing) dismiss(existing.id); // restart the lifetime instead of stacking duplicates
    const id = nextId++;
    const items = [...store.get().items, { id, tone, message: text }];
    while (items.length > MAX_TOASTS) {
      const dropped = items.shift()!;
      cancels.get(dropped.id)?.();
      cancels.delete(dropped.id);
    }
    store.update({ items });
    cancels.set(id, timers.after(LIFETIME_MS[tone], () => dismiss(id)));
    return id;
  }

  return {
    store,
    items: () => store.get().items,
    push,
    info: (message: string) => push("info", message),
    success: (message: string) => push("success", message),
    warning: (message: string) => push("warning", message),
    error: (message: string) => push("danger", message),
    dismiss,
  };
}
export type Toasts = ReturnType<typeof createToasts>;
