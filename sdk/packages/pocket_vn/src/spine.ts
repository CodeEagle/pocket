import { createSpineRig, type SpineSkeletonInput, type SpineMeshFrame } from "@pocket/spine";
import { encodeNovelMesh } from "./mesh.ts";
import type { NovelModelFactory, NovelModelMesh, NovelModelInstance } from "./models.ts";

export interface NovelSpineSource { skeleton: SpineSkeletonInput; atlasText: string }

/** A factory over canonical build-loaded sources; no filesystem or DOM in JS. */
export function createNovelSpineFactory(sources: Readonly<Record<string, NovelSpineSource>>): NovelModelFactory {
  return (definition, initialIntent) => {
    if (definition.kind !== "spine") throw new Error(`No runtime connected for ${definition.kind}`);
    const source = sources[definition.source];
    if (!source) throw new Error(`Spine source was not bundled: ${definition.source}`);
    const rig = createSpineRig({ skeleton: source.skeleton, atlasText: source.atlasText, textureKeys: definition.textures, yAxis: "down" });
    const frames = (): SpineMeshFrame[] => rig.frame().map(item => {
      if (item.kind === "unsupported") throw new Error(`Spine ${item.slot}: ${item.reason} (${item.detail})`);
      if (item.premultipliedAlpha) throw new Error(`Spine ${item.slot}: premultiplied atlas pages require texture normalization`);
      return item;
    });
    let signature = "";
    let previousAnimation = "";
    let previousLoop: boolean | undefined;
    let previousSkin: string | undefined;
    const setIntent: NovelModelInstance["setIntent"] = intent => {
      const next = JSON.stringify(intent);
      if (next === signature) return;
      if (intent.key !== initialIntent.key) throw new Error("A model instance cannot change its resource key");
      if (intent.expression) throw new Error("Spine uses skins; Live2D expressions are not supported");
      if (intent.skin !== previousSkin) {
        rig.setSkin(intent.skin);
        previousSkin = intent.skin;
      }
      const animation = intent.animation ?? rig.animationNames[0];
      const loop = intent.loop ?? true;
      if (animation && (animation !== previousAnimation || loop !== previousLoop)) {
        if (previousAnimation && previousAnimation !== animation) rig.setMix(previousAnimation, animation, .2);
        rig.play(animation, { loop });
        previousAnimation = animation;
        previousLoop = loop;
      }
      signature = next;
    };
    let initial: SpineMeshFrame[];
    try {
      setIntent(initialIntent);
      // Apply the initial animation at phase zero before measuring the setup
      // bounds. In particular, a model with no default skin can have no setup
      // attachments until its selected initial skin is applied.
      rig.advance(0);
      initial = frames();
    } catch (error) { rig.dispose(); throw error; }
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const frame of initial) for (let i = 0; i < frame.positions.length; i += 2) {
      minX = Math.min(minX, frame.positions[i]!); maxX = Math.max(maxX, frame.positions[i]!);
      minY = Math.min(minY, frame.positions[i + 1]!); maxY = Math.max(maxY, frame.positions[i + 1]!);
    }
    const scale = Number.isFinite(minX) ? Math.min(220 / Math.max(1, maxX - minX), 330 / Math.max(1, maxY - minY)) : 1;
    const offsetX = Number.isFinite(minX) ? (240 - (maxX - minX) * scale) / 2 - minX * scale : 120;
    const offsetY = Number.isFinite(minY) ? 340 - maxY * scale : 340;
    const buffers = new Map<string, { vertices: Float32Array; geometry?: Uint8Array }>();
    return {
      setIntent,
      advance(deltaMs) {
        if (!Number.isFinite(deltaMs) || deltaMs < 0) throw new Error("Invalid Spine frame interval");
        rig.advance(deltaMs / 1000);
        const active = new Set<string>();
        const meshes: NovelModelMesh[] = frames().map(frame => {
          const id = `${frame.slot}:${frame.attachment}`;
          active.add(id);
          let buffer = buffers.get(id);
          const length = frame.positions.length * 2;
          if (!buffer || buffer.vertices.length !== length) { buffer = { vertices: new Float32Array(length) }; buffers.set(id, buffer); }
          const uv = (value: number) => {
            if (!Number.isFinite(value) || value < -1e-6 || value > 1 + 1e-6) throw new Error("Spine atlas UV exceeds its texture page");
            return Math.max(0, Math.min(1, value));
          };
          for (let i = 0; i < frame.positions.length / 2; i++) {
            buffer.vertices[i * 4] = frame.positions[i * 2]! * scale + offsetX;
            buffer.vertices[i * 4 + 1] = frame.positions[i * 2 + 1]! * scale + offsetY;
            buffer.vertices[i * 4 + 2] = uv(frame.uvs[i * 2]!);
            buffer.vertices[i * 4 + 3] = uv(frame.uvs[i * 2 + 1]!);
          }
          const rgba = frame.rgba.map(value => Math.round(Math.max(0, Math.min(1, value)) * 255));
          const color = ((rgba[0]! | rgba[1]! << 8 | rgba[2]! << 16 | rgba[3]! << 24) >>> 0);
          buffer.geometry = encodeNovelMesh({ vertices: buffer.vertices, indices: frame.triangles, color }, buffer.geometry);
          return { id, texture: frame.texture, geometry: buffer.geometry };
        });
        for (const id of buffers.keys()) if (!active.has(id)) buffers.delete(id);
        return meshes;
      },
      dispose() { rig.dispose(); buffers.clear(); },
    };
  };
}

/** BuildGuest installs data from novel.assets.json before the entry executes. */
export function createBundledNovelSpineFactory(): NovelModelFactory {
  const bundled = (globalThis as { __pocketNovelModelSources?: Record<string, { kind: string; skeleton: { format: "json" | "binary"; data: unknown }; atlasText: string }> }).__pocketNovelModelSources ?? {};
  const sources: Record<string, NovelSpineSource> = {};
  for (const [path, source] of Object.entries(bundled)) if (source.kind === "spine") sources[path] = {
    atlasText: source.atlasText,
    skeleton: source.skeleton.format === "binary"
      ? { format: "binary", data: new Uint8Array(source.skeleton.data as number[]) }
      : { format: "json", data: source.skeleton.data as Record<string, unknown> },
  };
  return createNovelSpineFactory(sources);
}
