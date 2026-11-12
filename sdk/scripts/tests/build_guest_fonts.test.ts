import { expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { buildGuest } from "../build_guest.ts";
import { resolvePrebuiltTools } from "../prebuilt_tools.mjs";
import { FONT_CMAP_ENTRY_SIZE, FONT_HEADER_SIZE } from "../../.cache/pocketjs/contracts/spec/spec.ts";
import { keyFont, unpack } from "../../.cache/pocketjs/framework/compiler/pak.ts";

const BUILD_GUEST_FONT_TEST_TIMEOUT_MS = 120_000;
const sdkRoot = resolve(import.meta.dir, "../..");

function writeProject(projectRoot: string, fonts?: unknown): void {
  const pocket: Record<string, unknown> = { app: { entry: "app.tsx" } };
  if (fonts !== undefined) pocket.fonts = fonts;
  writeFileSync(join(projectRoot, "pocket.json"), JSON.stringify(pocket));
  writeFileSync(join(projectRoot, "manifest.json"), JSON.stringify({ capabilities: { requires: [] } }));
  writeFileSync(join(projectRoot, "app.tsx"), `export default function App() {
  return <view>
    <text class="text-4xl" value="MMMMMMMMMM" />
    <text class="text-4xl font-bold" value="MMMMMMMMMM" />
  </view>;
}
`);
}

function fontAtlas(pakPath: string, slot: number): Uint8Array {
  const entry = unpack(new Uint8Array(readFileSync(pakPath))).find((blob) => blob.key === keyFont(slot));
  if (!entry) throw new Error(`pinned build did not produce ${keyFont(slot)}`);
  return entry.data;
}

function glyphAdvance(atlas: Uint8Array, codepoint: number): number {
  const view = new DataView(atlas.buffer, atlas.byteOffset, atlas.byteLength);
  const glyphCount = view.getUint16(6, true);
  let tofuAdvance: number | undefined;
  for (let i = 0; i < glyphCount; i++) {
    const offset = FONT_HEADER_SIZE + i * FONT_CMAP_ENTRY_SIZE;
    const current = view.getUint32(offset, true);
    if (current === 0xfffd) tofuAdvance = view.getUint8(offset + 6);
    if (current === codepoint) return view.getUint8(offset + 6);
  }
  if (tofuAdvance !== undefined) return tofuAdvance;
  throw new Error(`font atlas has neither U+${codepoint.toString(16)} nor the tofu glyph`);
}

/** Apply a fixed line-width budget to actual compiler PAK advances. */
function wrappedLineCount(text: string, lineWidth: number, advance: (codepoint: number) => number): number {
  let lines = 1;
  let used = 0;
  for (const character of text) {
    const width = advance(character.codePointAt(0)!);
    if (used > 0 && used + width > lineWidth) {
      lines++;
      used = 0;
    }
    used += width;
  }
  return lines;
}

test("build_guest rejects malformed or escaping primary font declarations before compiler setup", async () => {
  const externalFont = join(tmpdir(), `pocket-font-outside-${process.pid}.otf`);
  writeFileSync(externalFont, Uint8Array.from([1, 2, 3, 4]));
  const cases: Array<{ name: string; fonts: unknown; message: RegExp; link?: boolean }> = [
    { name: "array", fonts: [], message: /fonts must be an object/ },
    { name: "unknown-key", fonts: { primary: "font.otf" }, message: /unknown field primary/ },
    { name: "empty-object", fonts: {}, message: /must declare regular and\/or bold/ },
    { name: "empty-path", fonts: { regular: "" }, message: /nonempty project-relative/ },
    { name: "absolute", fonts: { regular: externalFont }, message: /must stay inside projectRoot/ },
    { name: "traversal", fonts: { regular: "../outside.otf" }, message: /must stay inside projectRoot/ },
    { name: "wrong-extension", fonts: { regular: "fonts/font.bin" }, message: /must use a \.ttf or \.otf/ },
    { name: "missing", fonts: { regular: "fonts/missing.otf" }, message: /file does not exist/ },
    { name: "symlink", fonts: { regular: "fonts/linked.otf" }, message: /regular font file/, link: true },
  ];

  try {
    for (const fixture of cases) {
      const project = mkdtempSync(join(tmpdir(), `pocket-build-font-invalid-${fixture.name}-`));
      const logs: string[] = [];
      try {
        writeProject(project, fixture.fonts);
        if (fixture.link) {
          mkdirSync(join(project, "fonts"), { recursive: true });
          symlinkSync(externalFont, join(project, "fonts/linked.otf"));
        }
        await expect(buildGuest({ projectRoot: project, outDir: join(project, "out"), log: (line) => logs.push(line) }))
          .rejects.toThrow(fixture.message);
        expect(logs.some((line) => line.includes("compiler="))).toBe(false);
      } finally {
        rmSync(project, { recursive: true, force: true });
      }
    }
  } finally {
    rmSync(externalFont, { force: true });
  }
});

test("pinned build bakes pocket.json regular and bold faces into PAK metrics and wrapping", async () => {
  const project = mkdtempSync(join(tmpdir(), "pocket-build-font-primary-"));
  const configured = join(project, "configured");
  const baseline = join(project, "baseline");
  const fontPath = join(configured, "fonts/NotoSansCJK-Demo.otf");
  const compilerRoot = process.env.POCKET_SOURCE_BUILD === "1"
    ? join(sdkRoot, ".cache/pocketjs")
    : resolvePrebuiltTools(sdkRoot).compiler;
  const packagedFont = join(compilerRoot, "assets/fonts/NotoSansCJK-Demo.otf");
  try {
    mkdirSync(baseline, { recursive: true });
    mkdirSync(configured, { recursive: true });
    mkdirSync(join(configured, "fonts"), { recursive: true });
    copyFileSync(packagedFont, fontPath);
    writeProject(baseline);
    writeProject(configured, { regular: "fonts/NotoSansCJK-Demo.otf", bold: "fonts/NotoSansCJK-Demo.otf" });

    const hostFontBuild = await buildGuest({ projectRoot: baseline, outDir: join(baseline, "out-host") });
    const hostEntries = unpack(new Uint8Array(readFileSync(hostFontBuild.pak)));
    expect(hostEntries.some((blob) => blob.key.startsWith("ui:font."))).toBe(false);
    expect(hostEntries.some((blob) => blob.key === "ui:fonts.host")).toBe(true);
    const hostMetadata = JSON.parse(readFileSync(join(baseline, "out-host/app.bytecode.json"), "utf8"));
    const hostManifest = JSON.parse(readFileSync(join(baseline, "out-host/guest-manifest.json"), "utf8"));
    expect(hostMetadata.fonts).toBe("host");
    expect(hostManifest.fonts).toBe("host");
    expect(hostManifest.capabilities.requires).toContain("text.layout.native");

    const defaultBuild = await buildGuest({ projectRoot: baseline, outDir: join(baseline, "out"), bakeFonts: true });
    expect(unpack(new Uint8Array(readFileSync(defaultBuild.pak))).some((blob) => blob.key === "ui:fonts.host")).toBe(false);
    const primaryBuild = await buildGuest({ projectRoot: configured, outDir: join(configured, "out") });
    const bakedMetadata = JSON.parse(readFileSync(join(baseline, "out/app.bytecode.json"), "utf8"));
    const bakedManifest = JSON.parse(readFileSync(join(baseline, "out/guest-manifest.json"), "utf8"));
    expect(bakedMetadata.fonts).toBe("baked");
    expect(bakedManifest.fonts).toBe("baked");
    expect(bakedManifest.capabilities.requires).not.toContain("text.layout.native");
    expect(readFileSync(hostFontBuild.pak).byteLength).toBeLessThan(readFileSync(defaultBuild.pak).byteLength);
    const defaultRegular = fontAtlas(defaultBuild.pak, 6);
    const primaryRegular = fontAtlas(primaryBuild.pak, 6);
    const defaultBold = fontAtlas(defaultBuild.pak, 13);
    const primaryBold = fontAtlas(primaryBuild.pak, 13);

    const m = "M".codePointAt(0)!;
    const defaultRegularAdvance = glyphAdvance(defaultRegular, m);
    const primaryRegularAdvance = glyphAdvance(primaryRegular, m);
    const defaultBoldAdvance = glyphAdvance(defaultBold, m);
    const primaryBoldAdvance = glyphAdvance(primaryBold, m);
    expect(primaryRegularAdvance).not.toBe(defaultRegularAdvance);
    expect(primaryBoldAdvance).not.toBe(defaultBoldAdvance);

    const text = "MMMMMMMMMM";
    const width = 300;
    expect(wrappedLineCount(text, width, (codepoint) => glyphAdvance(defaultRegular, codepoint)))
      .not.toBe(wrappedLineCount(text, width, (codepoint) => glyphAdvance(primaryRegular, codepoint)));
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
}, BUILD_GUEST_FONT_TEST_TIMEOUT_MS);
