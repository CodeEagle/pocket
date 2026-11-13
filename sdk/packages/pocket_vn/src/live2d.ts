import {
  applyCubismExpression3, createPocketLive2dClient, evaluateCubismMotion3,
  createCubismInteractionController, parseCubismExpression3, parseCubismModel3, parseCubismMotion3,
  type CubismMotion3, type CubismMotionFrame, type PocketLive2dHost,
} from "@pocket/live2d";
import { createCubismPhysics3Simulation } from "@pocket/live2d/physics";
import { CubismPose3Simulation } from "@pocket/live2d/pose";
import type { CharacterModelIntent } from "./types.ts";
import type { NovelModelFactory, NovelModelMesh, NovelModelInstance, NovelModelPoint } from "./models.ts";

export interface NovelLive2dSource {
  document: unknown;
  physics?: unknown;
  pose?: unknown;
  /** Stable model3 group:index keys, for example Idle:0. */
  motions: Readonly<Record<string, unknown>>;
  expressions: Readonly<Record<string, unknown>>;
}
export interface NovelLive2dOptions {
  onError?: (error: unknown) => void;
  /** Experimental A/B switch; false keeps the legacy full-topology bridge. */
  cacheStaticTopology?: boolean;
}
let nextModel = 0;
const maxFrameDeltaMs = 5000;

/** JS owns motion selection and time. Native Core supplies deformation facts;
 * the existing retained mesh renderer owns geometry and compositing. */
export function createNovelLive2dFactory(host: PocketLive2dHost, sources: Readonly<Record<string, NovelLive2dSource>>, options: NovelLive2dOptions = {}): NovelModelFactory {
  return async (definition, initialIntent) => {
    if (definition.kind !== "live2d") throw new Error(`No runtime connected for ${definition.kind}`);
    const source = sources[definition.source];
    if (!source) throw new Error(`Live2D source was not bundled: ${definition.source}`);
    const manifest = parseCubismModel3(source.document);
    const groupIds = (name: string) => manifest.groups.filter(group => group.name === name).flatMap(group => group.ids);
    const eyeBlinkIds = groupIds("EyeBlink");
    const lipSyncIds = groupIds("LipSync");
    if (manifest.physics && source.physics === undefined) throw new Error(`Live2D physics source was not bundled: ${manifest.physics}`);
    if (manifest.pose && source.pose === undefined) throw new Error(`Live2D pose source was not bundled: ${manifest.pose}`);
    for (const texture of manifest.textures) if (!definition.textures[texture]) throw new Error(`Live2D texture is not mapped to a PAK image: ${texture}`);
    const motions = new Map(Object.entries(source.motions).map(([name, value]) => [name, parseCubismMotion3(value)]));
    const expressions = new Map(Object.entries(source.expressions).map(([name, value]) => [name, parseCubismExpression3(value)]));
    const client = createPocketLive2dClient(host, {
      cacheStaticTopology: options.cacheStaticTopology === true,
    });
    const nativeSource = definition.source.replace(/^assets\//, "");
    const slash = nativeSource.lastIndexOf("/");
    const info = await client.load({ id: `vn-live2d-${++nextModel}`, assetPrefix: slash < 0 ? "" : nativeSource.slice(0, slash), manifest });
    let disposed = false;
    let latestDrawables: Awaited<ReturnType<typeof client.update>>["drawables"] | undefined;
    let dragParameters: Readonly<Record<string, number>> = {};
    let transientMotion: CubismMotion3 | undefined;
    let transientMotionSeconds = 0;
    const release = () => { void client.dispose().catch(error => options.onError?.(error)); };
    try {
      if (!(info.canvas.widthPixels > 0 && info.canvas.heightPixels > 0)) throw new Error("Live2D canvas dimensions must be positive");
      const scale = Math.min(220 / info.canvas.widthPixels, 330 / info.canvas.heightPixels);
      const dx = (240 - info.canvas.widthPixels * scale) / 2;
      const dy = 340 - info.canvas.heightPixels * scale;
      const interaction = definition.interactive === true
        ? createCubismInteractionController({
          hitAreas: manifest.hitAreas,
          parameters: info.parameterMetadata ?? [],
          canvas: info.canvas,
          placement: { dx, dy, scale },
        })
        : undefined;
      const physics = manifest.physics
        ? info.parameterMetadata
          ? createCubismPhysics3Simulation(source.physics, info.parameterMetadata)
          : (() => { throw new Error("Live2D physics requires real Core parameter minimum, maximum and default facts"); })()
        : undefined;
      const pose = manifest.pose
        ? info.parts
          ? new CubismPose3Simulation(source.pose, info.parts, info.parameterDefaults)
          : (() => { throw new Error("Live2D pose requires real Core part IDs and default opacity facts"); })()
        : undefined;
      const defaults = Object.fromEntries(info.parameterDefaults.map(item => [item.id, item.value]));
      let motion: CubismMotion3 | undefined;
      let animation: string | undefined;
      let loop = true;
      let expression: string | undefined;
      let seconds = 0;
      const setIntent = (intent: CharacterModelIntent) => {
        if (disposed) throw new Error("Live2D model is disposed");
        if (intent.key !== initialIntent.key) throw new Error("A model instance cannot change its resource key");
        if (intent.skin) throw new Error("Live2D uses named expressions; Spine skins are not supported");
        const next = intent.animation ?? definition.animations?.[0] ?? motions.keys().next().value;
        if (next !== undefined && !motions.has(next)) throw new Error(`Unknown Live2D motion: ${next}`);
        if (intent.expression && !expressions.has(intent.expression)) throw new Error(`Unknown Live2D expression: ${intent.expression}`);
        if (intent.expression && !Object.keys(defaults).length) throw new Error("Live2D host did not provide official parameter defaults for expressions");
        if (next !== animation || (intent.loop ?? true) !== loop) {
          animation = next; loop = intent.loop ?? true; seconds = 0;
          motion = next === undefined ? undefined : { ...motions.get(next)!, loop };
          transientMotion = undefined;
          transientMotionSeconds = 0;
        }
        expression = intent.expression;
      };
      setIntent(initialIntent);
      const instance: NovelModelInstance = {
        setIntent,
        ...(interaction ? {
          hitTest(point: NovelModelPoint) {
            return !disposed && latestDrawables !== undefined && interaction.hitAreaAt(latestDrawables, point) !== undefined;
          },
          tap(point: NovelModelPoint) {
            if (disposed || !latestDrawables) return false;
            const area = interaction.hitAreaAt(latestDrawables, point);
            if (!area) return false;
            const group = `Tap${area.name}`;
            const name = [...motions.keys()].find(key => key === group || key.startsWith(`${group}:`));
            const selected = name === undefined ? undefined : motions.get(name);
            if (selected) {
              transientMotion = { ...selected, loop: false };
              transientMotionSeconds = 0;
            }
            return true;
          },
          drag(point: NovelModelPoint) {
            if (disposed) return;
            dragParameters = Object.fromEntries(interaction.dragParameters(point).map(entry => [entry.id, entry.value]));
          },
          endDrag() { dragParameters = {}; },
        } : {}),
        async advance(deltaMs) {
          if (disposed) throw new Error("Live2D model is disposed");
          if (!Number.isFinite(deltaMs) || deltaMs < 0) throw new Error("Invalid Live2D frame interval");
          const boundedDeltaMs = Math.min(deltaMs, maxFrameDeltaMs);
          seconds += boundedDeltaMs / 1000;
          let sample: CubismMotionFrame = motion ? evaluateCubismMotion3(motion, seconds) : { parameters: {}, partOpacities: {}, modelValues: {} };
          if (transientMotion) {
            sample = evaluateCubismMotion3(transientMotion, transientMotionSeconds);
            transientMotionSeconds += boundedDeltaMs / 1000;
            if (transientMotionSeconds >= transientMotion.duration) {
              transientMotion = undefined;
              transientMotionSeconds = 0;
            }
          }
          const sampled: Record<string, number> = { ...defaults, ...sample.parameters };
          if (sample.modelValues.EyeBlink !== undefined) for (const id of eyeBlinkIds) {
            sampled[id] = Object.hasOwn(sample.parameters, id) ? sampled[id]! * sample.modelValues.EyeBlink : sample.modelValues.EyeBlink;
          }
          if (sample.modelValues.LipSync !== undefined) for (const id of lipSyncIds) sampled[id] = (sampled[id] ?? 0) + sample.modelValues.LipSync;
          let parameters: Readonly<Record<string, number>> = sampled;
          if (expression) parameters = applyCubismExpression3(parameters, expressions.get(expression)!);
          if (Object.keys(dragParameters).length > 0) parameters = { ...parameters, ...dragParameters };
          if (physics) parameters = physics.advance(parameters, boundedDeltaMs / 1000);
          let partOpacities: Readonly<Record<string, number>> = sample.partOpacities;
          if (pose) {
            const parameterWrites = new Set(Object.keys(sample.parameters));
            for (const id of Object.keys(dragParameters)) parameterWrites.add(id);
            if (expression) for (const entry of expressions.get(expression)!.parameters) parameterWrites.add(entry.id);
            if (sample.modelValues.EyeBlink !== undefined) for (const id of eyeBlinkIds) parameterWrites.add(id);
            if (sample.modelValues.LipSync !== undefined) for (const id of lipSyncIds) parameterWrites.add(id);
            for (const id of physics?.outputParameterIds ?? []) parameterWrites.add(id);
            const poseFrame = pose.update(parameters, sample.partOpacities, parameterWrites, boundedDeltaMs / 1000);
            parameters = poseFrame.parameters;
            partOpacities = poseFrame.partOpacities;
          }
          const modelOpacity = sample.modelValues.Opacity ?? 1;
          const frame = await client.update(
            info.modelId,
            Object.entries(parameters).map(([id, value]) => ({ id, value })),
            Object.entries(partOpacities).map(([id, value]) => ({ id, value })),
            { dx, dy, scale, opacity: modelOpacity },
          );
          if (disposed) return [];
          latestDrawables = frame.drawables;
          const meshes = frame.drawables.filter(drawable => drawable.meshBytes.byteLength > 0).map((drawable): NovelModelMesh => {
            const alphaBlend = (drawable.blendMode >>> 8) & 0xff;
            const colorBlend = drawable.blendMode & 0xff;
            // Cubism 5.2 compatibility modes preserve destination alpha. They
            // must not be approximated by Skia add/multiply on a transparent layer.
            const blend = ({ 0: "normal", 3: "add", 6: "multiply", 10: "screen" } as const)[colorBlend as 0 | 3 | 6 | 10];
            if (!blend || alphaBlend !== 0 || (drawable.blendMode >>> 16) !== 0) throw new Error(`Live2D ${drawable.id}: unsupported color/alpha blend ${colorBlend}/${alphaBlend}`);
            const opacity = Math.round(Math.max(0, Math.min(1, drawable.opacity * modelOpacity)) * 255);
            const rgb = (values: readonly number[]): [number, number, number] => [values[0]!, values[1]!, values[2]!];
            const texture = definition.textures[manifest.textures[drawable.textureIndex]!];
            if (!texture) throw new Error(`Live2D ${drawable.id}: texture index outside the mapped model pages`);
            const masks = drawable.maskIndices.map(index => {
              const mask = frame.drawables[index];
              if (!mask) throw new Error(`Live2D ${drawable.id}: mask index outside the model`);
              return mask;
            }).filter(mask => mask.meshBytes.byteLength > 0);
            const inverted = (drawable.constantFlags & 8) !== 0;
            // A union of empty ArtMeshes has zero coverage. Avoid inventing
            // geometry while preserving normal/inverted mask semantics.
            const emptyMask = drawable.maskIndices.length > 0 && masks.length === 0;
            const multiplyRgb = rgb(drawable.multiplyColorRgba);
            const screenRgb = rgb(drawable.screenColorRgba);
            return {
              id: drawable.id,
              texture,
              geometry: drawable.meshBytes,
              visible: (drawable.dynamicFlags & 1) !== 0 && opacity > 0 && (!emptyMask || inverted),
              effect: {
                blend,
                // Official Cubism Metal/OpenGL samplers repeat. Preserve raw
                // out-of-range UVs instead of distorting an ArtMesh by clamping.
                repeatTexture: true,
                masks: masks.map(mask => mask.id),
                inverted: masks.length > 0 && inverted,
                multiplyRgb,
                screenRgb,
              },
            };
          });
          const order = new Map(frame.drawables.map(item => [item.id, item.renderOrder]));
          meshes.sort((left, right) => order.get(left.id)! - order.get(right.id)!);
          return meshes;
        },
        dispose() { if (disposed) return; disposed = true; physics?.dispose(); pose?.dispose(); release(); },
      };
      return instance;
    } catch (error) { release(); throw error; }
  };
}

export function createBundledNovelLive2dFactory(host: PocketLive2dHost, options?: NovelLive2dOptions): NovelModelFactory {
  const bundled = (globalThis as { __pocketNovelModelSources?: Record<string, NovelLive2dSource & { kind: string }> }).__pocketNovelModelSources ?? {};
  return createNovelLive2dFactory(host, Object.fromEntries(Object.entries(bundled).filter(([, source]) => source.kind === "live2d")), options);
}
