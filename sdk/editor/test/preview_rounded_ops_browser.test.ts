import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "bun:test";
import { chromium } from "playwright";

test("Web Preview paints native rounded and rounded-gradient DrawOps", { timeout: 30_000 }, async () => {
  const source = readFileSync(new URL("../client/preview.js", import.meta.url), "utf8");
  const server = Bun.serve({ port: 0, fetch() {
    return new Response(
      `<div data-pocket-preview data-project-id="rounded-ops"><canvas></canvas></div><script>${source.replaceAll("</script", "<\\/script")}</script>`,
      { headers: { "content-type": "text/html" } },
    );
  } });
  const browser = await chromium.launch({ headless: true });
  try {
    for (const deviceScaleFactor of [1, 2]) {
      const context = await browser.newContext({ viewport: { width: 64, height: 64 }, deviceScaleFactor });
      const page = await context.newPage();
      await page.addInitScript(() => {
        class Source {
          onmessage?: (event: { data: string }) => void;
          constructor() { (window as any).__source = this; }
          close() {}
        }
        Object.defineProperty(window, "EventSource", { value: Source });
      });
      await page.goto(`http://127.0.0.1:${server.port}/`);
      await page.waitForFunction(() => Boolean((window as any).PocketEditorPreviewInstance && (window as any).__source));
      const pixels = await page.evaluate(async () => {
        const operations = [
          { type: "rect", x: 0, y: 0, w: 128, h: 128, color: 0xff112233 },
          { type: "rounded", x: 2, y: 2, w: 20, h: 20, radius: 8, color: 0xffff0000 },
          { type: "rounded", x: 2, y: 28, w: 20, h: 20, radius: 10, borderWidth: 4, color: 0xff00ff00 },
          { type: "rounded", x: 28, y: 2, w: 28, h: 20, radius: 8, color: 0xff0000ff, clip: { x: 28, y: 2, w: 12, h: 20 } },
          { type: "roundedGradient", x: 28, y: 28, w: 32, h: 32, radius: 8, fromColor: 0xffff0000, viaColor: 0xff00ff00, viaPosition: 0.5, toColor: 0xff0000ff, direction: 0 },
          { type: "gradient", x: 2, y: 80, w: 24, h: 20, fromColor: 0xffff0000, toColor: 0xff0000ff, direction: 0 },
          { type: "gradient", x: 30, y: 80, w: 24, h: 20, fromColor: 0xffff0000, toColor: 0xff0000ff, direction: 1 },
          { type: "gradient", x: 58, y: 80, w: 24, h: 20, fromColor: 0xffff0000, toColor: 0xff0000ff, direction: 2 },
          { type: "gradient", x: 86, y: 80, w: 24, h: 20, fromColor: 0xffff0000, toColor: 0xff0000ff, direction: 3 },
          { type: "gradient", x: 116, y: 80, w: 10, h: 20, fromColor: 0xffff0000, toColor: 0xff0000ff },
        ];
        (window as any).__source.onmessage({
          data: JSON.stringify({ type: "frame", frame: { frame: 1, width: 128, height: 128, ops: operations, events: [], resources: [] } }),
        });
        await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
        const canvas = (window as any).PocketEditorPreviewInstance.canvas as HTMLCanvasElement;
        const context = canvas.getContext("2d")!;
        const scale = canvas.width / 128;
        const sample = (x: number, y: number) => Array.from(context.getImageData(Math.floor(x * scale), Math.floor(y * scale), 1, 1).data);
        return {
          backing: [canvas.width, canvas.height],
          roundedCorners: [[2, 2], [21, 2], [2, 21], [21, 21]].map(([x, y]) => sample(x, y)),
          roundedCenter: sample(12, 12),
          ringCorner: sample(2, 28),
          ringStroke: sample(12, 29),
          ringCenter: sample(12, 38),
          clippedFill: sample(34, 10),
          clippedOutside: sample(44, 10),
          gradientCorner: sample(28, 28),
          gradientTop: sample(44, 30),
          gradientMiddle: sample(44, 44),
          gradientBottom: sample(44, 58),
          legacyDir0Top: sample(14, 81),
          legacyDir0Bottom: sample(14, 98),
          legacyDir1Top: sample(42, 81),
          legacyDir1Bottom: sample(42, 98),
          legacyDir2Left: sample(59, 90),
          legacyDir2Right: sample(80, 90),
          legacyDir3Left: sample(87, 90),
          legacyDir3Right: sample(108, 90),
          legacyDefaultTop: sample(121, 81),
          legacyDefaultBottom: sample(121, 98),
        };
      });

      const background = [17, 34, 51, 255];
      assert.deepEqual(pixels.backing, [128 * deviceScaleFactor, 128 * deviceScaleFactor]);
      assert.ok(pixels.roundedCorners.every(pixel => pixel.every((channel, index) => channel === background[index])), "all four rounded corners stay transparent");
      assert.deepEqual(pixels.roundedCenter, [255, 0, 0, 255]);
      assert.deepEqual(pixels.ringCorner, background, "rounded border keeps its outer corner");
      assert.deepEqual(pixels.ringStroke, [0, 255, 0, 255]);
      assert.deepEqual(pixels.ringCenter, background, "rounded border paints an inward hollow ring");
      assert.deepEqual(pixels.clippedFill, [0, 0, 255, 255]);
      assert.deepEqual(pixels.clippedOutside, background, "the DrawOp clip remains active for rounded paint");
      assert.deepEqual(pixels.gradientCorner, background, "rounded gradient leaves its corner transparent");
      assert.ok(pixels.gradientTop[2]! > pixels.gradientTop[1]!, `direction 0 must approach the top color: ${JSON.stringify(pixels.gradientTop)}`);
      assert.ok(
        pixels.gradientMiddle[0]! <= 10 && pixels.gradientMiddle[1]! >= 245 && pixels.gradientMiddle[2]! <= 10,
        `optional middle stop is applied at its declared position: ${JSON.stringify(pixels.gradientMiddle)}`,
      );
      assert.ok(pixels.gradientBottom[0]! > pixels.gradientBottom[1]!, `direction 0 must start at the bottom color: ${JSON.stringify(pixels.gradientBottom)}`);
      assert.ok(pixels.legacyDir0Top[2]! > pixels.legacyDir0Top[0]! && pixels.legacyDir0Bottom[0]! > pixels.legacyDir0Bottom[2]!, "legacy gradient direction 0 runs bottom to top");
      assert.ok(pixels.legacyDir1Top[0]! > pixels.legacyDir1Top[2]! && pixels.legacyDir1Bottom[2]! > pixels.legacyDir1Bottom[0]!, "legacy gradient direction 1 runs top to bottom");
      assert.ok(pixels.legacyDir2Left[2]! > pixels.legacyDir2Left[0]! && pixels.legacyDir2Right[0]! > pixels.legacyDir2Right[2]!, "legacy gradient direction 2 runs right to left");
      assert.ok(pixels.legacyDir3Left[0]! > pixels.legacyDir3Left[2]! && pixels.legacyDir3Right[2]! > pixels.legacyDir3Right[0]!, "legacy gradient direction 3 runs left to right");
      assert.ok(pixels.legacyDefaultTop[2]! > pixels.legacyDefaultTop[0]! && pixels.legacyDefaultBottom[0]! > pixels.legacyDefaultBottom[2]!, "omitted legacy direction defaults to Flutter direction 0");
      await context.close();
    }
  } finally {
    await browser.close();
    await server.stop(true);
  }
});

test("native JS pointer frames paint rounded shapes and legacy gradients", { timeout: 30_000 }, async () => {
  const { spawnSync } = await import("node:child_process");
  const { existsSync } = await import("node:fs");
  const { resolve } = await import("node:path");
  const probe = process.env.POCKET_NATIVE_PROBE ?? resolve(import.meta.dir, "../../native/target/debug/pocket_probe");
  assert.ok(existsSync(probe), `real native probe required: ${probe}`);
  const guest = `
    function shape(x,y,w,h,props) {
      const n=ui.createNode(0);
      for(const [p,v] of [[1,w],[2,h],[24,1],[28,x],[25,y],...props]) ui.setProp(n,p,v);
      ui.insertBefore(1,n,0); return n;
    }
    const fill=shape(4,4,32,24,[[64,0xff0000ff],[68,8]]);
    shape(4,52,84,12,[[65,0xff0000ff],[66,0xffff0000],[67,3]]);
    shape(4,68,84,20,[[65,0xff0000ff],[66,0xffff0000],[67,3],[68,8]]);
    globalThis.frame=function(){};
    globalThis.__pocketEvent=function(e){
      if(e.name==='input.pointer') {
        ui.setProp(fill,64,0xff00ff00);
      }
    };
    __pocketEvent.__binaryCapable=true;
  `;
  const commands = [
    { op: "create", width: 96, height: 88 },
    { op: "eval", source: guest, render: true },
    { op: "send", message: { type: "event", name: "input.pointer", payload: { phase: "up", id: 0, x: 20, y: 16 } } },
    { op: "frame", deltaMs: 16 },
    { op: "send", message: { type: "event", name: "input.pointer", payload: { phase: "cancel", id: 0, x: 20, y: 16 } } },
    { op: "frame", deltaMs: 16 }, { op: "quit" },
  ];
  const native = spawnSync(probe, [], { input: commands.map(command => JSON.stringify(command)).join("\n") + "\n", encoding: "utf8", timeout: 10_000 });
  assert.equal(native.status, 0, native.stderr);
  const responses = native.stdout.trim().split("\n").map(line => JSON.parse(line));
  for (const response of responses) assert.equal(response.ok, true, JSON.stringify(response));
  const frames = responses.filter(response => response.frame).map(response => response.frame);
  assert.equal(frames.length, 3);
  for (const kind of ['rounded', 'gradient', 'roundedGradient']) assert.ok(frames[0].ops.some((op: any) => op.type === kind));
  assert.equal(frames[0].ops.find((op: any) => op.type === "gradient").direction, 3);
  assert.equal(frames[0].ops.find((op: any) => op.type === "roundedGradient").direction, 3);
  const source = readFileSync(new URL("../client/preview.js", import.meta.url), "utf8");
  const server = Bun.serve({ port: 0, fetch: () => new Response(`<div data-pocket-preview data-project-id="native-arcs"></div><script>${source.replaceAll("</script", "<\\/script")}</script>`, { headers: { "content-type": "text/html" } }) });
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 96, height: 88 }, deviceScaleFactor: 1 });
    await page.addInitScript(() => {
      class Source { onmessage: any; constructor() { (window as any).__source = this; } close() {} }
      (window as any).EventSource = Source;
      (window as any).fetch = async () => new Response('{}');
    });
    await page.goto(`http://127.0.0.1:${server.port}/`);
    const pixels = await page.evaluate(async (frames) => {
      const instance = (window as any).PocketEditorPreviewInstance;
      const canvas = instance.canvas as HTMLCanvasElement;
      async function render(frame: any) {
        (window as any).__source.onmessage({ data: JSON.stringify({ type: "frame", frame }) });
        await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
        const ctx = canvas.getContext('2d')!;
        const sample = (x: number, y: number) => Array.from(ctx.getImageData(x, y, 1, 1).data);
        return { fill: sample(20, 16), corner: sample(4, 4), gradientLeft: sample(10, 58), gradientRight: sample(81, 58), roundedGradientLeft: sample(10, 78), roundedGradientRight: sample(81, 78) };
      }
      const results = [];
      for (const frame of frames) results.push(await render(frame));
      const ablated = await render({ ...frames[0], ops: frames[0].ops.filter((op: any) => !['rounded', 'gradient', 'roundedGradient'].includes(op.type)) });
      await instance.close();
      return { results, ablated };
    }, frames);
    const white = [255, 255, 255, 255], red = [255, 0, 0, 255], green = [0, 255, 0, 255];
    const [positive, negative] = pixels.results;
    assert.deepEqual(positive!.fill, red);
    assert.deepEqual(negative!.fill, green, "pointer input changes real JS output pixels");
    assert.deepEqual(positive!.corner, white);
    assert.ok(positive!.gradientLeft[0]! > 220 && positive!.gradientLeft[2]! < 40);
    assert.ok(positive!.gradientRight[2]! > 220 && positive!.gradientRight[0]! < 40);
    assert.ok(positive!.roundedGradientLeft[0]! > 220 && positive!.roundedGradientLeft[2]! < 40);
    assert.ok(positive!.roundedGradientRight[2]! > 220 && positive!.roundedGradientRight[0]! < 40);
    assert.ok(positive!.gradientLeft[0]! > 220 && positive!.gradientRight[2]! > 220, "native gradient direction 3 runs left to right");
    assert.deepEqual(pixels.ablated.fill, white); assert.deepEqual(pixels.ablated.gradientLeft, white);
  } finally { await browser.close(); server.stop(true); }
});
