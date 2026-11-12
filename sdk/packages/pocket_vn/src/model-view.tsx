import { Index, Show, batch, createEffect, createMemo, createRenderEffect, createSignal, onCleanup, untrack, type JSX } from "solid-js";
import { getOps } from "@pocketjs/framework/solid";
import { Text, View } from "@pocketjs/framework/solid/components";
import type { CharacterModelIntent } from "./types.ts";
import type { NovelAnimationDriver, NovelModelDefinition, NovelModelFactory, NovelModelInstance, NovelModelMesh } from "./models.ts";
import { NovelMeshView } from "./mesh-view.tsx";
import { encodeNovelMeshEffect } from "./mesh-effect.ts";

export function NovelModelView(props: {
  definition: NovelModelDefinition;
  intent: CharacterModelIntent;
  factory?: NovelModelFactory;
  animations?: NovelAnimationDriver;
}): JSX.Element {
  const [meshes, setMeshes] = createSignal<readonly NovelModelMesh[]>([]);
  const [error, setError] = createSignal("");
  const [version, setVersion] = createSignal(0);
  const [nodeRevision, setNodeRevision] = createSignal(0);
  const nodeIds: number[] = [];
  const effectBuffers = new Map<number, Uint8Array>();
  let current: NovelModelInstance | undefined;
  let failCurrent: ((cause: unknown) => void) | undefined;
  // Story ticks may publish a fresh intent object with the same key. Keep
  // the official runtime alive until the resource itself changes.
  const resourceKey = createMemo(() => props.intent.key);
  createEffect(() => {
    const definition = props.definition;
    const key = resourceKey();
    const factory = props.factory;
    const animations = props.animations;
    let alive = true;
    let instance: NovelModelInstance | undefined;
    let unregister: (() => void) | undefined;
    let busy = false;
    let failed = false;
    let elapsed = 0;
    setError(""); setMeshes([]);
    const fail = (cause: unknown) => {
      if (!alive || failed) return;
      failed = true;
      setError(cause instanceof Error ? cause.message : String(cause));
      const failedInstance = instance;
      const removeAnimation = unregister;
      unregister = undefined;
      removeAnimation?.();
      instance = undefined;
      if (current === failedInstance) current = undefined;
      if (failCurrent === fail) failCurrent = undefined;
      failedInstance?.dispose();
      setMeshes([]);
    };
    failCurrent = fail;
    if (!factory || !animations) { setError(`模型 ${key} 未连接运行库`); return; }
    Promise.resolve().then(() => factory(definition, untrack(() => props.intent))).then(async value => {
      if (!alive) { value.dispose(); return; }
      current = instance = value;
      value.setIntent(untrack(() => props.intent));
      const advance = (deltaMs: number) => {
        if (failed) return;
        elapsed = Math.min(250, elapsed + deltaMs);
        if (busy) return;
        busy = true;
        const delta = elapsed; elapsed = 0;
        Promise.resolve().then(() => value.advance(delta)).then(frame => {
          if (alive && !failed) batch(() => { setMeshes([...frame]); setVersion(value => value + 1); });
        }).catch(fail).finally(() => { busy = false; });
      };
      unregister = animations.register(advance);
      advance(0);
    }).catch(fail);
    onCleanup(() => { alive = false; const removeAnimation = unregister; unregister = undefined; removeAnimation?.(); if (current === instance) current = undefined; if (failCurrent === fail) failCurrent = undefined; const activeInstance = instance; instance = undefined; activeInstance?.dispose(); });
  });
  createEffect(() => {
    const intent = props.intent;
    try { current?.setIntent(intent); } catch (cause) { failCurrent?.(cause); }
  });
  const nodesReady = createMemo(() => { nodeRevision(); return meshes().every((_, index) => nodeIds[index] !== undefined); });
  const result = <View class="absolute inset-0 w-full h-full">
    <Index each={meshes()}>{(mesh, index) => <NovelMeshView src={mesh().texture} geometry={mesh().geometry} version={version()} class="absolute inset-0 w-full h-full"
      style={{ opacity: nodesReady() && mesh().visible !== false ? 1 : 0 }}
      onNode={id => { nodeIds[index] = id; setNodeRevision(value => value + 1); }} />}</Index>
    <Show when={error()}><View class="absolute inset-0 p-2 bg-[#101F27]"><Text class="text-xs text-[#F0B78F]">{error()}</Text></View></Show>
  </View>;
  createRenderEffect(() => {
    nodeRevision(); version();
    const frame = meshes();
    if (!nodesReady()) return;
    const ops = getOps() as ReturnType<typeof getOps> & { setMeshEffect?(id: number, bytes: Uint8Array): boolean };
    const ids = new Map(frame.map((mesh, index) => [mesh.id, nodeIds[index]!]));
    try { frame.forEach((mesh, index) => {
      const node = nodeIds[index]!;
      if (!mesh.effect && !effectBuffers.has(node)) return;
      if (!ops.setMeshEffect) throw new Error("Pocket host does not support mesh compositing");
      const bytes = mesh.effect ? encodeNovelMeshEffect(mesh.effect, id => {
        const mask = ids.get(id);
        if (mask === undefined) throw new Error(`Missing model mask mesh: ${id}`);
        return mask;
      }) : new Uint8Array(0);
      // Encode separately: effects and their colour arrays may be mutated in
      // place, so reusing the committed buffer would erase the comparison.
      const previous = effectBuffers.get(node);
      if (previous && previous.length === bytes.length && bytes.every((value, offset) => value === previous[offset])) return;
      if (!ops.setMeshEffect(node, bytes)) throw new Error("Pocket refused invalid model compositing");
      if (mesh.effect) effectBuffers.set(node, bytes); else effectBuffers.delete(node);
    }); } catch (cause) { failCurrent?.(cause); return; }
    const activeNodes = new Set(nodeIds.slice(0, frame.length));
    for (const node of effectBuffers.keys()) if (!activeNodes.has(node)) effectBuffers.delete(node);
    nodeIds.length = frame.length;
  });
  return result;
}
