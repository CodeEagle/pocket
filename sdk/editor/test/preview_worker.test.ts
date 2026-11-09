import { strict as assert } from "node:assert";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { test } from "bun:test";
import { buildGuest } from "../../scripts/build_guest.ts";
import { createPreviewManager } from "../preview.ts";

const sdkRoot = resolve(import.meta.dir, "../..");
const nativeProbe = process.env.POCKET_NATIVE_PROBE ?? join(sdkRoot, "native/target/debug/pocket_probe");
const workerApp = join(sdkRoot, ".cache/pocketjs/apps/worker-http");

test("real preview attaches Worker channels before UI eval and runs HTTP provider", { timeout: 120_000 }, async () => {
  const project = await mkdtemp(join(tmpdir(), "pocket-preview-worker-http-"));
  const output = join(project, "out");
  let requests = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => {
      requests += 1;
      return new Response("preview-http-ok");
    },
  });
  const origin = `http://127.0.0.1:${server.port}`;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    await cp(join(workerApp, "main.tsx"), join(project, "app.tsx"));
    const workerSource = (await readFile(join(workerApp, "worker.ts"), "utf8"))
      .replaceAll("https://example.com/", `${origin}/`)
      .replace(
        "if (!ended) publish(5, total, outcome.status);",
        "if (!ended) publish(outcome.status === ResourceStatus.ok ? 4 : 5, total, outcome.status);",
      )
      .replace('for await (const _ of io.channel("request").observe()) await fetchOnce();', "fetchOnce();");
    await writeFile(join(project, "worker.ts"), workerSource);
    const sourcePocket = JSON.parse(await readFile(join(workerApp, "pocket.json"), "utf8")) as Record<string, any>;
    await writeFile(join(project, "pocket.json"), JSON.stringify({
      ...sourcePocket,
      app: { ...sourcePocket.app, entry: "app.tsx" },
      domains: { worker: { ...sourcePocket.domains.worker, entry: "worker.ts" } },
    }));
    await writeFile(join(project, "manifest.json"), JSON.stringify({
      capabilities: { requires: ["runtime.worker", "net.http", "input.buttons", "text.glyphs.baked"] },
    }));
    const built = await buildGuest({ projectRoot: project, outDir: output, tickHz: 60 });
    assert.ok(built.worker?.bytecode, "build must emit app.worker.qjbc");

    const manager = createPreviewManager({
      probePath: nativeProbe,
      width: 390,
      height: 360,
      workerHttpOrigins: [origin],
      artifacts: {
        bytecodePath: built.bytecode,
        pakPath: built.pak,
        metadataPath: built.metadata,
        projectDirectory: output,
        tickHz: 60,
      },
    });
    const id = "worker-http-preview";
    const base = `http://127.0.0.1/api/projects/${id}/preview`;
    try {
      const stream = await manager.handle(new Request(`${base}/stream`), id, "stream");
      assert.equal(stream.status, 200);
      reader = stream.body!.getReader();
      await reader.read();

      const deadline = Date.now() + 10_000;
      let snapshot: any;
      while (Date.now() < deadline) {
        const response = await manager.handle(new Request(`${base}/snapshot`), id, "snapshot");
        snapshot = await response.json();
        const text = snapshot.frame?.ops
          ?.filter((op: Record<string, unknown>) => op.type === "text")
          .map((op: Record<string, unknown>) => op.text);
        if (text?.includes("Complete")) break;
        await Bun.sleep(25);
      }
      assert.equal(snapshot.status.state, "ready");
      assert.equal(snapshot.status.error, undefined);
      assert.equal(requests, 1, "native Worker HTTP provider must reach the loopback server");
      const text = snapshot.frame.ops
        .filter((op: Record<string, unknown>) => op.type === "text")
        .map((op: Record<string, unknown>) => op.text);
      assert.ok(text.includes("Complete"), "worker-to-UI channel did not report a successful HTTP completion");
      assert.ok(text.includes("Bytes: 15 / status: 0"), `HTTP completion did not carry the expected body/status: ${text.join(" | ")}`);
    } finally {
      await reader?.cancel();
      await manager.dispose();
    }
  } finally {
    server.stop(true);
    await rm(project, { recursive: true, force: true });
  }
});
