import type { CharacterModelIntent } from "./types.ts";

export interface NovelModelDefinition {
  kind: "spine" | "live2d";
  source: string;
  atlas?: string;
  textures: Readonly<Record<string, string>>;
  animations?: readonly string[];
  /** Opt in to model3 hit-area taps and Core-ranged pointer tracking. */
  interactive?: boolean;
}
export interface NovelModelPoint { readonly x: number; readonly y: number; }
export interface NovelModelMesh {
  id: string;
  texture: string;
  /** Validated PMS1 geometry; the native core retains one copy. */
  geometry: Uint8Array;
  /** Hidden meshes remain registered so other drawables can use their masks. */
  visible?: boolean;
  effect?: NovelModelEffect;
}
export interface NovelModelEffect {
  blend: "normal" | "add" | "multiply" | "screen";
  /** Repeat texture coordinates across atlas edges, as required by Cubism. */
  repeatTexture?: boolean;
  masks?: readonly string[];
  inverted?: boolean;
  multiplyRgb?: readonly [number, number, number];
  screenRgb?: readonly [number, number, number];
}
export interface NovelModelInstance {
  setIntent(intent: CharacterModelIntent): void;
  /** Implementations serialize native work and report unsupported features. */
  advance(deltaMs: number): readonly NovelModelMesh[] | Promise<readonly NovelModelMesh[]>;
  /** Optional Live2D hit-area/gesture surface, in the 240×350 model-view px coordinate space. */
  hitTest?(point: NovelModelPoint): boolean;
  /** Trigger a transient hit-area motion without changing narrative intent. */
  tap?(point: NovelModelPoint): boolean;
  /** Update drag tracking from an absolute point in model-view px. */
  drag?(point: NovelModelPoint): void;
  /** Release drag overrides; subsequent frames resume the authored motion values. */
  endDrag?(): void;
  dispose(): void;
}
export type NovelModelFactory = (definition: NovelModelDefinition, intent: CharacterModelIntent) => NovelModelInstance | Promise<NovelModelInstance>;

/** One scheduler shared by all model instances; no duplicate narrative state. */
export function createNovelAnimationDriver() {
  const actors = new Set<(deltaMs: number) => void>();
  const listeners = new Set<() => void>();
  const notify = () => { for (const listener of listeners) listener(); };
  return {
    needsClock: () => actors.size > 0,
    advance(deltaMs: number) { for (const actor of actors) actor(deltaMs); },
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    register(actor: (deltaMs: number) => void) {
      actors.add(actor); notify();
      return () => { if (actors.delete(actor)) notify(); };
    },
  };
}
export type NovelAnimationDriver = ReturnType<typeof createNovelAnimationDriver>;
