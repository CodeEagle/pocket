import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startEditor } from "../server.ts";
import { createPreviewManager } from "../preview.ts";
import { createFileDiagnostics } from "../../packages/pocket_diagnostics/src/node.ts";

test("an unexpected idle probe exit retains stderr without waiting for another input", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pocket-idle-probe-crash-"));
  const probePath = join(directory, "probe.mjs");
  writeFileSync(join(directory, "app.qjbc"), new Uint8Array([0]));
  writeFileSync(join(directory, "app.pak"), new Uint8Array([0]));
  // Process-protocol fixture: exercise an actual child process exit, not a UI error message.
  writeFileSync(probePath, `#!/usr/bin/env bun
import { createInterface } from 'node:readline';
let frame=0, armed=false;
createInterface({input:process.stdin}).on('line', line=>{
 const c=JSON.parse(line);
 let result={ok:true};
 if(c.op==='frame') {
   result.frame={frame:++frame,width:80,height:80,ops:[],events:[],resources:[]};
   if(!armed){armed=true;setTimeout(()=>{process.stderr.write('native fixture panic\\n');process.exit(23)},150)}
 }
 if(c.op==='schedule') result.nextWakeDelayMs=-1;
 process.stdout.write(JSON.stringify(result)+'\\n');
 if(c.op==='quit') process.exit(0);
});
`);
  chmodSync(probePath, 0o755);
  const diagnostics = createFileDiagnostics({ directory: join(directory, "records") });
  const preview = createPreviewManager({ diagnostics, probePath, width: 80, height: 80,
    artifacts: { bytecodePath: join(directory, "app.qjbc"), pakPath: join(directory, "app.pak"), revision: 3 } });
  let stream: Response | undefined;
  try {
    stream = await preview.handle(new Request("http://localhost/api/projects/idle-crash/preview/stream"), "idle-crash");
    expect(stream.status).toBe(200);
    const deadline = Date.now() + 3000;
    let crashes: any[] = [];
    while (Date.now() < deadline) {
      crashes = [...await diagnostics.listCrashes()];
      if (crashes.length) break;
      await Bun.sleep(10);
    }
    expect(crashes).toHaveLength(1);
    expect(crashes[0].error.message).toContain("pocket_probe exited (23)");
    expect(crashes[0].error.message).toContain("native fixture panic");
    expect(crashes[0].runtimeId).toBe("idle-crash");
    expect((await preview.status("idle-crash")).state).toBe("error");
  } finally {
    await stream?.body?.cancel();
    await preview.dispose();
    await diagnostics.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("preview startup failures persist their original error before session disposal", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pocket-preview-diagnostic-"));
  const diagnostics = createFileDiagnostics({ directory });
  const preview = createPreviewManager({ diagnostics, artifacts: { bytecodePath: join(directory, "missing.qjbc"), pakPath: join(directory, "missing.pak"), revision: 7 } });
  try {
    const response = await preview.handle(new Request("http://localhost/api/projects/broken/preview/stream"), "broken");
    expect(response.ok).toBe(false);
    await preview.dispose();
    await diagnostics.close();
    const reopened = createFileDiagnostics({ directory });
    try {
      const crashes = await reopened.listCrashes({ projectId: "broken" });
      expect(crashes).toHaveLength(1);
      expect(crashes[0]!.source).toBe("studio.preview");
      expect(crashes[0]!.error.message.length).toBeGreaterThan(0);
    } finally { await reopened.close(); }
  } finally {
    await preview.dispose();
    await diagnostics.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Studio retains crash and log records across restart with project-scoped export", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "pocket-studio-diagnostics-"));
  for (const id of ["one", "two"]) mkdirSync(join(workspace, "projects", id), { recursive: true });
  let server = await startEditor({ workspace, port: 0, updatePort: 0 });
  const request = (id: string, suffix = "", init?: RequestInit) => fetch(
    `http://127.0.0.1:${server.port}/api/projects/${id}/diagnostics${suffix}`, init,
  );
  const report = (kind: string, message: string) => ({ method: "POST", headers: { "x-pocket-editor": "1", "content-type": "application/json" },
    body: JSON.stringify({ kind, message, error: { name: "Error", message, stack: "original native stack" }, projectId: "two", source: "native", unhandled: true }),
  });
  try {
    const denied = await request("one", "", { ...report("crash", "denied"), headers: { "content-type": "application/json" } });
    expect(denied.status).toBe(403);
    expect((await request("one", "", report("log", "before frame failure"))).status).toBe(201);
    const crash = await request("one", "", report("crash", "pocket_frame returned JSON larger than 64 MiB"));
    expect(crash.status).toBe(201);
    const crashId = (await crash.json()).id;
    await server.stop(true);
    server = await startEditor({ workspace, port: 0, updatePort: 0 });
    const bundle = await (await request("one")).json();
    expect(bundle.logCount).toBe(1);
    expect(bundle.crashCount).toBe(1);
    const retained = bundle.records.find((record: any) => record.id === crashId);
    expect(retained.message).toContain("64 MiB");
    expect(retained.source).toBe("studio.browser");
    expect(retained.projectId).toBe("one");
    expect(retained.error.stack).toBe("original native stack");
    expect((await (await request("two")).json()).records).toEqual([]);
    const download = await request("one", "?kind=crash&download=1");
    expect(download.headers.get("content-disposition")).toContain("one-diagnostics.json");
    expect((await download.json()).records.map((record: any) => record.id)).toEqual([crashId]);
    expect((await request("one", "?kind=invalid")).status).toBe(422);
    expect((await request("one", "", report("crash", "x".repeat(70 * 1024)))).status).toBe(413);
  } finally {
    await server.stop(true);
    rmSync(workspace, { recursive: true, force: true });
  }
});
