import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildGuest } from "../../../sdk/scripts/build_guest.ts";
import { NativeSession } from "./native_session.ts";

test("compiled JS input deforms a retained textured mesh through the native DrawList", async () => {
  const project = mkdtempSync(join(tmpdir(), "pocket-mesh-guest-"));
  const oldProbe = process.env.POCKET_NATIVE_PROBE;
  process.env.POCKET_NATIVE_PROBE = resolve(import.meta.dir, "../../../sdk/native/target/debug/pocket_probe");
  let session: NativeSession | undefined;
  try {
    writeFileSync(join(project, "package.json"), JSON.stringify({ dependencies: { "@pocket/vn": "file:" + resolve(import.meta.dir, "../../../sdk/packages/pocket_vn") } }));
    writeFileSync(join(project, "pocket.json"), JSON.stringify({ app: { entry: "app.tsx" } }));
    writeFileSync(join(project, "manifest.json"), JSON.stringify({ capabilities: { requires: [] } }));
    writeFileSync(join(project, "mesh.svg"), '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="#37c4ad"/><circle cx="32" cy="32" r="15" fill="#e9b35b"/></svg>');
    writeFileSync(join(project, "novel.assets.json"), JSON.stringify({ backgrounds: { mesh: "mesh.svg" } }));
    writeFileSync(join(project, "app.tsx"), `import { createSignal } from "solid-js";
import { mount } from "@pocketjs/framework/solid";
import { Focusable, View } from "@pocketjs/framework/solid/components";
import { NovelMeshView } from "@pocket/vn/mesh-view";
import { encodeNovelMesh } from "@pocket/vn/mesh";
function App() {
 const [moved, setMoved] = createSignal(false);
 const geometry = () => encodeNovelMesh({ vertices: [moved() ? 40 : 10,10,0,0, 150,10,1,0, 80,160,.5,1], indices:[0,1,2], color:0x80ffffff });
 return <View class="w-full h-full bg-[#08151D]"><NovelMeshView src="mesh.svg" geometry={geometry()} class="absolute left-0 top-0 w-[180] h-[180]"/><Focusable class="absolute left-0 top-[200] w-[180] h-[80] bg-[#273B44]" onPress={() => setMoved(!moved())}/></View>;
}
mount(App);
`);
    const result = await buildGuest({ projectRoot: project, outDir: join(project, "out") });
    const metadata = JSON.parse(readFileSync(result.metadata, "utf8"));
    session = new NativeSession({ bytecodePath: result.bytecode, pakPath: result.pak, metadataPath: result.metadata, runtimeAbi: metadata.runtimeAbi }, { width: 200, height: 320 });
    let frame = await session.boot();
    const triangles = (value: typeof frame) => value.ops?.filter(op => op.type === "textureTriangle") ?? [];
    expect(triangles(frame)).toHaveLength(1);
    expect(triangles(frame)[0]?.points?.[0]?.x).toBe(10);
    frame = await session.tapPoint({ x: 90, y: 240 });
    expect(triangles(frame)).toHaveLength(1);
    expect(triangles(frame)[0]?.points?.[0]?.x).toBe(40);
    expect(triangles(frame)[0]?.color).toBe(0x80ffffff);
    frame = await session.tapPoint({ x: 90, y: 240 });
    expect(triangles(frame)[0]?.points?.[0]?.x).toBe(10);
  } finally {
    await session?.quit();
    if (oldProbe === undefined) delete process.env.POCKET_NATIVE_PROBE; else process.env.POCKET_NATIVE_PROBE = oldProbe;
    rmSync(project, { recursive: true, force: true });
  }
}, 120000);
