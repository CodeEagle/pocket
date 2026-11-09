import {
  AnimationState,
  AnimationStateData,
  AtlasAttachmentLoader,
  BlendMode,
  ClippingAttachment,
  MeshAttachment,
  Physics,
  RegionAttachment,
  Skeleton,
  SkeletonBinary,
  SkeletonClipping,
  SkeletonJson,
  TextureAtlas,
  type TextureAtlasRegion,
  type NumberArrayLike,
} from "@esotericsoftware/spine-core";

export type SpineSkeletonInput =
  | { format: "json"; data: string | Record<string, unknown> }
  | { format: "binary"; data: Uint8Array | ArrayBuffer };

export interface SpineRigInput {
  skeleton: SpineSkeletonInput;
  atlasText: string;
  /** Atlas page filename to Pocket logical texture key. */
  textureKeys: Readonly<Record<string, string>>;
  /** Spine coordinates use y-up. Pocket canvases normally use y-down. */
  yAxis?: "up" | "down";
  /** Multiplies Spine world coordinates before returning frame positions. */
  coordinateScale?: number;
}

export interface SpineMeshFrame {
  kind: "mesh";
  slot: string;
  attachment: string;
  texture: string;
  /** Interleaving is deliberately not used: x/y pairs in rig-local coordinates. */
  positions: Float32Array;
  /** u/v pairs normalized in the texture page. */
  uvs: Float32Array;
  /** Triangle indices into positions/uvs. */
  triangles: Uint32Array;
  /** Skeleton × slot × attachment tint, as unpremultiplied normalized RGBA. */
  rgba: readonly [number, number, number, number];
  blendMode: "normal";
  /** True when SkeletonClipping generated this mesh's output vertices. */
  clipped: boolean;
  /** TextureAtlas page metadata; the texture itself is owned by Pocket. */
  premultipliedAlpha: boolean;
}

export interface SpineUnsupportedFrame {
  kind: "unsupported";
  slot: string;
  attachment: string;
  reason: "blend-mode" | "two-color-tint" | "texture-page" | "attachment-type";
  detail: string;
}

export type SpineFrameItem = SpineMeshFrame | SpineUnsupportedFrame;

export interface SpineRig {
  readonly disposed: boolean;
  readonly animationNames: readonly string[];
  readonly skinNames: readonly string[];
  /** Configure Spine's own cross-fade duration between two animation names. */
  setMix(from: string, to: string, seconds: number): void;
  /** Select a Spine skin, or restore the setup/default skin when omitted. */
  setSkin(name?: string | null): void;
  /** Play a Spine animation on one Spine track; this is not a Pocket player state machine. */
  play(name: string, options?: { loop?: boolean; track?: number }): void;
  /** Advance official Spine state, apply its pose, and update world transforms. */
  advance(deltaSeconds: number): void;
  /** Read a stable copy of current renderable meshes in Spine draw order. */
  frame(): SpineFrameItem[];
  dispose(): void;
}

function colorProduct(
  skeleton: { r: number; g: number; b: number; a: number },
  slot: { r: number; g: number; b: number; a: number },
  attachment: { r: number; g: number; b: number; a: number },
): readonly [number, number, number, number] {
  return [
    skeleton.r * slot.r * attachment.r,
    skeleton.g * slot.g * attachment.g,
    skeleton.b * slot.b * attachment.b,
    skeleton.a * slot.a * attachment.a,
  ];
}

function unsupported(
  slot: string,
  attachment: string,
  reason: SpineUnsupportedFrame["reason"],
  detail: string,
): SpineUnsupportedFrame {
  return { kind: "unsupported", slot, attachment, reason, detail };
}

function loadSkeleton(input: SpineSkeletonInput, atlas: TextureAtlas): Skeleton {
  const attachmentLoader = new AtlasAttachmentLoader(atlas);
  const data = input.format === "json"
    ? new SkeletonJson(attachmentLoader).readSkeletonData(input.data)
    : new SkeletonBinary(attachmentLoader).readSkeletonData(input.data);
  return new Skeleton(data);
}

export function createSpineRig(input: SpineRigInput): SpineRig {
  const coordinateScale = input.coordinateScale ?? 1;
  if (!Number.isFinite(coordinateScale) || coordinateScale <= 0) {
    throw new RangeError("coordinateScale must be a finite positive number");
  }

  const atlas = new TextureAtlas(input.atlasText);
  for (const page of atlas.pages) {
    const textureKey = input.textureKeys[page.name];
    if (!textureKey) {
      atlas.dispose();
      throw new Error(`No Pocket texture key configured for atlas page: ${page.name}`);
    }
  }

  let skeleton: Skeleton;
  try {
    skeleton = loadSkeleton(input.skeleton, atlas);
  } catch (error) {
    atlas.dispose();
    throw error;
  }

  const stateData = new AnimationStateData(skeleton.data);
  const state = new AnimationState(stateData);
  const clipping = new SkeletonClipping();
  let disposed = false;
  const ySign = input.yAxis === "up" ? 1 : -1;
  const animationNames = Object.freeze(skeleton.data.animations.map((animation) => animation.name));
  const skinNames = Object.freeze(skeleton.data.skins.map((skin) => skin.name));

  const assertOpen = () => {
    if (disposed) throw new Error("Spine rig has been disposed");
  };

  const toPocketPositions = (source: Float32Array, vertexCount: number) => {
    const result = new Float32Array(vertexCount * 2);
    for (let i = 0; i < vertexCount; i++) {
      result[i * 2] = source[i * 2] * coordinateScale;
      result[i * 2 + 1] = source[i * 2 + 1] * coordinateScale * ySign;
    }
    return result;
  };

  const makeFrame = (
    slot: (typeof skeleton.slots)[number],
    attachment: RegionAttachment | MeshAttachment,
    world: Float32Array,
    verticesCount: number,
    sourceUvs: Float32Array,
    sourceTriangles: ArrayLike<number>,
    triangleCount: number,
    wasClipped: boolean,
    region: TextureAtlasRegion,
  ): SpineMeshFrame => {
    const pose = slot.appliedPose;
    const color = colorProduct(skeleton.color, pose.color, attachment.color);
    const positions = toPocketPositions(world, verticesCount);
    const uvs = new Float32Array(verticesCount * 2);
    uvs.set(sourceUvs.subarray(0, verticesCount * 2));
    const triangles = new Uint32Array(triangleCount);
    for (let i = 0; i < triangleCount; i++) triangles[i] = sourceTriangles[i];
    return {
      kind: "mesh",
      slot: slot.data.name,
      attachment: attachment.name,
      texture: input.textureKeys[region.page.name],
      positions,
      uvs,
      triangles,
      rgba: color,
      blendMode: "normal",
      clipped: wasClipped,
      premultipliedAlpha: region.page.pma,
    };
  };

  const rig: SpineRig = {
    get disposed() {
      return disposed;
    },
    animationNames,
    skinNames,
    setMix(from, to, seconds) {
      assertOpen();
      if (!Number.isFinite(seconds) || seconds < 0) {
        throw new RangeError("mix duration must be finite and non-negative");
      }
      stateData.setMix(from, to, seconds);
    },
    setSkin(name) {
      assertOpen();
      // Spine keeps setup attachments in SkeletonData.defaultSkin. Passing
      // that official skin (or null when none exists) and restoring slot setup
      // pose also removes attachments carried over from a previous skin.
      skeleton.setSkin(name ?? skeleton.data.defaultSkin);
      skeleton.setupPoseSlots();
      state.apply(skeleton);
      skeleton.updateWorldTransform(Physics.update);
    },
    play(name, options = {}) {
      assertOpen();
      const track = options.track ?? 0;
      if (!Number.isInteger(track) || track < 0) {
        throw new RangeError("track must be a non-negative integer");
      }
      state.setAnimation(track, name, options.loop ?? true);
    },
    advance(deltaSeconds) {
      assertOpen();
      if (!Number.isFinite(deltaSeconds) || deltaSeconds < 0) {
        throw new RangeError("deltaSeconds must be finite and non-negative");
      }
      skeleton.update(deltaSeconds);
      state.update(deltaSeconds);
      state.apply(skeleton);
      skeleton.updateWorldTransform(Physics.update);
    },
    frame() {
      assertOpen();
      const output: SpineFrameItem[] = [];
      const clipper = clipping;
      const drawOrder = skeleton.drawOrder.appliedPose;
      for (const slot of drawOrder) {
        if (!slot.bone.active) {
          clipper.clipEnd(slot);
          continue;
        }

        const attachment = slot.appliedPose.attachment;
        if (!attachment) {
          clipper.clipEnd(slot);
          continue;
        }

        if (attachment instanceof ClippingAttachment) {
          clipper.clipEnd(slot);
          clipper.clipStart(skeleton, slot, attachment);
          continue;
        }

        if (!(attachment instanceof RegionAttachment) && !(attachment instanceof MeshAttachment)) {
          clipper.clipEnd(slot);
          output.push(unsupported(slot.data.name, attachment.name, "attachment-type", attachment.constructor.name));
          continue;
        }

        const blendMode = slot.data.blendMode;
        if (blendMode !== BlendMode.Normal) {
          clipper.clipEnd(slot);
          output.push(unsupported(slot.data.name, attachment.name, "blend-mode", BlendMode[blendMode] ?? String(blendMode)));
          continue;
        }

        if (slot.appliedPose.darkColor) {
          clipper.clipEnd(slot);
          output.push(unsupported(slot.data.name, attachment.name, "two-color-tint", "Pocket mesh tint has one RGBA modulation color"));
          continue;
        }

        let world: Float32Array;
        let uvs: Float32Array;
        let triangles: NumberArrayLike | Uint16Array;
        let triangleCount: number;
        let verticesCount: number;
        let sequenceIndex: number;
        if (attachment instanceof RegionAttachment) {
          const pose = slot.appliedPose;
          sequenceIndex = attachment.sequence.resolveIndex(pose);
          const region = attachment.sequence.regions[sequenceIndex] as TextureAtlasRegion | null;
          if (!region) {
            clipper.clipEnd(slot);
            output.push(unsupported(slot.data.name, attachment.name, "texture-page", "Region sequence has no atlas page"));
            continue;
          }
          world = new Float32Array(8);
          attachment.computeWorldVertices(slot, attachment.getOffsets(pose), world, 0, 2);
          uvs = attachment.sequence.getUVs(sequenceIndex);
          triangles = [0, 1, 2, 2, 3, 0];
          triangleCount = 6;
          verticesCount = 4;
          const clipped = clipper.isClipping();
          if (clipped) {
            clipper.clipTrianglesUnpacked(world, 0, triangles, triangleCount, uvs, 2);
            output.push(makeFrame(
              slot,
              attachment,
              clipper.clippedVerticesTyped,
              clipper.clippedVerticesLength / 2,
              clipper.clippedUVsTyped,
              clipper.clippedTrianglesTyped,
              clipper.clippedTrianglesLength,
              true,
              region,
            ));
          } else {
            output.push(makeFrame(slot, attachment, world, verticesCount, uvs, triangles, triangleCount, false, region));
          }
          clipper.clipEnd(slot);
          continue;
        }

        sequenceIndex = attachment.sequence.resolveIndex(slot.appliedPose);
        const meshRegion = attachment.sequence.regions[sequenceIndex] as TextureAtlasRegion | null;
        if (!meshRegion) {
          clipper.clipEnd(slot);
          output.push(unsupported(slot.data.name, attachment.name, "texture-page", "Mesh sequence has no atlas page"));
          continue;
        }
        verticesCount = attachment.worldVerticesLength / 2;
        world = new Float32Array(attachment.worldVerticesLength);
        attachment.computeWorldVertices(skeleton, slot, 0, attachment.worldVerticesLength, world, 0, 2);
        uvs = attachment.sequence.getUVs(sequenceIndex);
        triangles = attachment.triangles;
        triangleCount = attachment.triangles.length;

        const clipped = clipper.isClipping();
        if (clipped) {
          clipper.clipTrianglesUnpacked(world, 0, triangles, triangleCount, uvs, 2);
          output.push(makeFrame(
            slot,
            attachment,
            clipper.clippedVerticesTyped,
            clipper.clippedVerticesLength / 2,
            clipper.clippedUVsTyped,
            clipper.clippedTrianglesTyped,
            clipper.clippedTrianglesLength,
            true,
            meshRegion,
          ));
        } else {
          output.push(makeFrame(slot, attachment, world, verticesCount, uvs, triangles, triangleCount, false, meshRegion));
        }
        clipper.clipEnd(slot);
      }
      clipper.clipEnd();
      return output;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      state.clearTracks();
      clipping.clipEnd();
      atlas.dispose();
    },
  };

  skeleton.setupPose();
  skeleton.updateWorldTransform(Physics.none);
  return rig;
}

export interface SpineAtlasPageInfo {
  readonly name: string;
  readonly premultipliedAlpha: boolean;
}

/** Read atlas page facts through the official reader without loading a skeleton or texture pixels. */
export function getSpineAtlasInfo(atlasText: string): readonly SpineAtlasPageInfo[] {
  const atlas = new TextureAtlas(atlasText);
  try {
    return Object.freeze(atlas.pages.map((page) => Object.freeze({ name: page.name, premultipliedAlpha: page.pma })));
  } finally {
    atlas.dispose();
  }
}

/** Parse page names through the official atlas reader, without decoding textures or loading a skeleton. */
export function getSpineAtlasPages(atlasText: string): readonly string[] {
  return Object.freeze(getSpineAtlasInfo(atlasText).map(page => page.name));
}
