/** Explicit development-only root replacement. Production updates still load QJBC. */
export type HotValue = null | boolean | number | string | HotValue[] | { [key: string]: HotValue };
export type HotContext = { protocol: 1; session: string; version: string };
export type HotTransition = HotContext & { base: string };
type Binding = { read: () => HotValue; write: (value: HotValue) => void };
type Snapshot = Record<string, HotValue>;

function clone(value: unknown): HotValue {
  let entries = 0;
  const seen = new Set<object>();
  const visit = (item: unknown, depth: number): void => {
    if (depth > 16 || ++entries > 4096) throw new Error("Hot state exceeds structural limits");
    if (item === null || typeof item === "string" || typeof item === "boolean") return;
    if (typeof item === "number" && Number.isFinite(item)) return;
    if (!item || typeof item !== "object" || seen.has(item)) throw new Error("Hot state must be finite, acyclic JSON");
    const prototype = Object.getPrototypeOf(item);
    if (!Array.isArray(item) && prototype !== Object.prototype && prototype !== null) throw new Error("Hot state must contain plain JSON objects");
    seen.add(item);
    for (const key of Object.keys(item)) visit((item as Record<string, unknown>)[key], depth + 1);
    seen.delete(item);
  };
  visit(value, 0);
  const text = JSON.stringify(value);
  let bytes = 0;
  for (const character of text) {
    const point = character.codePointAt(0)!;
    bytes += point < 128 ? 1 : point < 2048 ? 2 : point < 65536 ? 3 : 4;
  }
  if (bytes > 64 * 1024) throw new Error("Hot state exceeds 64 KiB");
  return JSON.parse(text) as HotValue;
}

function validContext(context: HotContext): boolean {
  return context.protocol === 1 && [context.session, context.version].every(value =>
    typeof value === "string" && value.length > 0 && value.length <= 128);
}

function createRuntime() {
  const bindings = new Map<string, Binding>();
  let root: (() => void) | undefined;
  let context: HotContext | undefined;
  let prepared: HotTransition | undefined;
  let pending: Snapshot | undefined;
  const checkpoint = (): Snapshot => {
    const data: Snapshot = Object.create(null);
    for (const [key, binding] of bindings) data[key] = binding.read();
    return clone(data) as Snapshot;
  };
  return {
    protocol: 1 as const,
    bind(next: HotContext): boolean {
      if (!validContext(next) || context) return false;
      context = { ...next };
      return true;
    },
    register(key: string, binding: Binding): () => void {
      if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(key) || bindings.has(key)) throw new Error("Invalid or duplicate hot state key");
      if (bindings.size >= 128) throw new Error("Too many hot state bindings");
      if (pending && Object.hasOwn(pending, key)) binding.write(clone(pending[key]));
      bindings.set(key, binding);
      return () => { if (bindings.get(key) === binding) bindings.delete(key); };
    },
    mount(mount: () => () => void): () => void {
      if (root) throw new Error("Only one hot root may be mounted");
      const dispose = mount();
      if (typeof dispose !== "function") throw new Error("A hot root must return its framework disposer");
      let disposed = false;
      const stop = () => {
        if (disposed) return;
        disposed = true;
        if (root === stop) root = undefined;
        dispose();
      };
      root = stop;
      return stop;
    },
    checkpoint,
    prepare(next: HotTransition): Snapshot {
      if (!validContext(next) || !context || next.session !== context.session ||
          next.base !== context.version || next.version === next.base || prepared || !root) {
        throw new Error("Hot update session/base does not match the mounted root");
      }
      const data = checkpoint();
      root();
      bindings.clear();
      pending = data;
      prepared = { ...next };
      return data;
    },
    commit(next: HotTransition): boolean {
      if (!prepared || !root || next.protocol !== 1 || next.session !== prepared.session ||
          next.base !== prepared.base || next.version !== prepared.version) throw new Error("Hot update was not prepared");
      context = { protocol: 1, session: next.session, version: next.version };
      prepared = undefined;
      pending = undefined;
      return true;
    },

  };
}

type Runtime = ReturnType<typeof createRuntime>;
const host = globalThis as typeof globalThis & { __pocketDevHot?: Runtime };
function runtime(): Runtime {
  if (host.__pocketDevHot && host.__pocketDevHot.protocol !== 1) throw new Error("Incompatible hot runtime");
  return host.__pocketDevHot ??= createRuntime();
}

/** Call within a component; return the cleanup to its normal lifecycle. */
export function registerHotState(key: string, binding: Binding): () => void {
  return runtime().register(key, binding);
}

/** Reuses the pinned framework's mount/dispose; never creates a second renderer. */
export function mountHotRoot(mount: () => () => void): () => void {
  return runtime().mount(mount);
}
