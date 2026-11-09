import { createRenderEffect, onCleanup, onMount, untrack, type JSX } from "solid-js";
import { getOps } from "@pocketjs/framework/host";
import { syncStyle } from "@pocketjs/framework/solid/renderer";
import { Text, type NodeMirror, type TextProps } from "@pocketjs/framework/solid/components";
import { inlineFontSlot, type InlineFontRole } from "@pocketjs/framework/inline-fonts";

export { inlineFontSlot, type InlineFontRole };

export interface InlineTextRuby {
  text: string;
  fontSlot?: number;
  color?: number;
}

/** Half-open range in Unicode codepoints (not JS UTF-16 indices). */
export interface InlineTextRun {
  start: number;
  end: number;
  fontSlot?: number;
  /** Core DrawList ABGR u32. */
  color?: number;
  ruby?: InlineTextRuby;
  linkId?: string;
}

export interface InlineTextRect { x: number; y: number; width: number; height: number; }
export interface InlineTextLinkLayout { id: string; rects: readonly InlineTextRect[]; }
export interface InlineTextLayout {
  width: number;
  height: number;
  lineCount: number;
  links: readonly InlineTextLinkLayout[];
}
export interface InlineTextHandle { getLayout(): InlineTextLayout; }
export interface InlineTextRef { current: InlineTextHandle | null; }

export interface InlineTextProps {
  source: string;
  runs: readonly InlineTextRun[];
  revealCodepoints: number;
  style: TextProps["style"];
  ref?: InlineTextRef;
  onLayout?: (layout: InlineTextLayout) => void;
  class?: string;
  debugName?: string;
}

const EMPTY_LAYOUT: InlineTextLayout = { width: 0, height: 0, lineCount: 0, links: [] };
const MAGIC = 0x31544952; // little-endian "RIT1"

interface EncodedRuns { bytes: Uint8Array; linkIds: readonly string[]; }

function encodeUtf8(value: string): Uint8Array {
  const out: number[] = [];
  for (const scalar of value) {
    const cp = scalar.codePointAt(0)!;
    if (cp <= 0x7f) out.push(cp);
    else if (cp <= 0x7ff) out.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
    else if (cp <= 0xffff) out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    else out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
  }
  return new Uint8Array(out);
}

function encodeRuns(source: string, runs: readonly InlineTextRun[]): EncodedRuns {
  const count = Array.from(source).length;
  const ordered = [...runs].sort((a, b) => a.start - b.start || a.end - b.end);
  let priorEnd = 0;
  const linkIds: string[] = [""];
  const linkIndices = new Map<string, number>();
  const normalized = ordered.map(run => {
    if (!Number.isInteger(run.start) || !Number.isInteger(run.end) || run.start < priorEnd
      || run.start < 0 || run.end <= run.start || run.end > count) {
      throw new RangeError(`InlineText run [${run.start}, ${run.end}) must be sorted, non-overlapping codepoint offsets within ${count}`);
    }
    priorEnd = run.end;
    let linkIndex = 0;
    if (run.linkId) {
      linkIndex = linkIndices.get(run.linkId) ?? linkIds.length;
      if (!linkIndices.has(run.linkId)) {
        linkIndices.set(run.linkId, linkIndex);
        linkIds.push(run.linkId);
      }
    }
    const ruby = run.ruby;
    const rubyBytes = ruby ? encodeUtf8(ruby.text) : new Uint8Array();
    const flags = (run.fontSlot !== undefined ? 1 : 0)
      | (run.color !== undefined ? 2 : 0)
      | (linkIndex !== 0 ? 4 : 0)
      | (ruby !== undefined ? 8 : 0)
      | (ruby?.fontSlot !== undefined ? 16 : 0)
      | (ruby?.color !== undefined ? 32 : 0);
    return { run, rubyBytes, flags, linkIndex };
  });
  const size = 8 + normalized.reduce((total, item) => total + 36 + item.rubyBytes.length, 0);
  const bytes = new Uint8Array(size);
  const view = new DataView(bytes.buffer);
  let offset = 0;
  const write = (value: number): void => { view.setUint32(offset, value >>> 0, true); offset += 4; };
  write(MAGIC);
  write(normalized.length);
  for (const { run, rubyBytes, flags, linkIndex } of normalized) {
    write(run.start); write(run.end); write(flags);
    write(run.fontSlot ?? 0xffff_ffff);
    write(run.color ?? 0xffff_ffff);
    write(linkIndex);
    write(run.ruby?.fontSlot ?? 0xffff_ffff);
    write(run.ruby?.color ?? 0xffff_ffff);
    write(rubyBytes.length);
    bytes.set(rubyBytes, offset);
    offset += rubyBytes.length;
  }
  return { bytes, linkIds };
}

function readFloat(words: readonly number[], index: number): number {
  const data = new DataView(new ArrayBuffer(4));
  data.setUint32(0, words[index] >>> 0, true);
  return data.getFloat32(0, true);
}

function decodeLayout(words: readonly number[], linkIds: readonly string[]): InlineTextLayout {
  if (words.length < 4) return EMPTY_LAYOUT;
  const width = readFloat(words, 0);
  const height = readFloat(words, 1);
  const lineCount = words[2] >>> 0;
  const linkCount = words[3] >>> 0;
  const links: InlineTextLinkLayout[] = [];
  let at = 4;
  for (let i = 0; i < linkCount; i++) {
    const linkIndex = words[at++] >>> 0;
    const rectCount = words[at++] >>> 0;
    const rects: InlineTextRect[] = [];
    for (let j = 0; j < rectCount && at + 3 < words.length; j++) {
      rects.push({ x: readFloat(words, at++), y: readFloat(words, at++),
        width: readFloat(words, at++), height: readFloat(words, at++) });
    }
    const id = linkIds[linkIndex];
    if (id !== undefined) links.push({ id, rects });
  }
  return { width, height, lineCount, links };
}

function close(a: number, b: number): boolean { return Math.abs(a - b) < 0.25; }

function sameLayout(a: InlineTextLayout, b: InlineTextLayout): boolean {
  if (!close(a.width, b.width) || !close(a.height, b.height) || a.lineCount !== b.lineCount
    || a.links.length !== b.links.length) return false;
  for (let i = 0; i < a.links.length; i++) {
    const left = a.links[i], right = b.links[i];
    if (left.id !== right.id || left.rects.length !== right.rects.length) return false;
    for (let j = 0; j < left.rects.length; j++) {
      const l = left.rects[j], r = right.rects[j];
      if (!close(l.x, r.x) || !close(l.y, r.y) || !close(l.width, r.width) || !close(l.height, r.height)) return false;
    }
  }
  return true;
}

export function InlineText(props: InlineTextProps): JSX.Element {
  let node: NodeMirror | undefined;
  let previousSource: string | undefined;
  let previousRuns: readonly InlineTextRun[] | undefined;
  let encoded: EncodedRuns | undefined;
  let previousReveal: number | undefined;
  let lastLayout = EMPTY_LAYOUT;
  let mounted = false;

  const sync = (): InlineTextLayout => {
    if (!node || !mounted) return EMPTY_LAYOUT;
    const ops = getOps();
    // A ref query is a synchronous read-after-write API. Solid may defer the
    // Text style effect until the current batch completes, so commit the
    // current explicit props through the same native-tree mirror path first.
    syncStyle(node, props.style);
    const source = props.source;
    const runs = props.runs;
    if (source !== previousSource || runs !== previousRuns || !encoded) {
      encoded = encodeRuns(source, runs);
      ops.setInlineText(node.id, source, encoded.bytes);
      previousSource = source;
      previousRuns = runs;
      // Core resets its reveal cursor when the full source/run table changes.
      // Re-send the current prop even when its numeric value is unchanged.
      previousReveal = undefined;
    }
    const reveal = Math.max(0, Math.floor(props.revealCodepoints));
    if (reveal !== previousReveal) {
      ops.setInlineReveal(node.id, reveal);
      previousReveal = reveal;
    }
    const next = decodeLayout(ops.getInlineTextLayout(node.id), encoded.linkIds);
    if (!sameLayout(lastLayout, next)) {
      lastLayout = next;
      props.onLayout?.(next);
    }
    return lastLayout;
  };

  const handle: InlineTextHandle = {
    getLayout: () => untrack(sync),
  };
  const element = Text({
    get class() { return props.class; },
    get debugName() { return props.debugName; },
    get style() { return props.style; },
    nodeRef: current => {
      node = current;
      if (props.ref) props.ref.current = current ? handle : null;
    },
  });
  createRenderEffect(() => {
    // Keep the leaf's cached Core layout current for normal reactive updates;
    // getLayout() also performs this synchronization for batched callers.
    props.style;
    props.source;
    props.runs;
    props.revealCodepoints;
    sync();
  });
  // The Text primitive installs its NodeMirror before that node is inserted
  // into the parent's tree. Core cannot produce the final Taffy geometry until
  // insertion, so query once here rather than publishing a permanent zero box
  // from the earlier createRenderEffect.
  onMount(() => { mounted = true; sync(); });
  onCleanup(() => { mounted = false; if (props.ref) props.ref.current = null; node = undefined; });
  return element;
}
