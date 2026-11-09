import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildGuest } from "../../../sdk/scripts/build_guest.ts";
import { NativeSession, type Frame } from "./native_session.ts";

test("compiled JS changes a hidden mesh mask and its MFX1 blend with real pointer input", async () => {
  const project = mkdtempSync(join(tmpdir(), "pocket-mesh-effect-"));
  let session: NativeSession | undefined;
  try {
    writeFileSync(join(project, "package.json"), JSON.stringify({ dependencies: { "@pocket/vn": "file:" + resolve(import.meta.dir, "../../../sdk/packages/pocket_vn") } }));
    writeFileSync(join(project, "pocket.json"), JSON.stringify({ app: { entry: "app.tsx" } }));
    writeFileSync(join(project, "manifest.json"), JSON.stringify({ capabilities: { requires: [] } }));
    writeFileSync(join(project, "mesh.svg"), '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="#37c4ad"/></svg>');
    writeFileSync(join(project, "novel.assets.json"), JSON.stringify({ backgrounds: { mesh: "mesh.svg" } }));
    writeFileSync(join(project, "app.tsx"), `import { createRenderEffect, createSignal } from "solid-js";
import { getOps, mount } from "@pocketjs/framework/solid";
import { Focusable, View } from "@pocketjs/framework/solid/components";
import { NovelMeshView } from "@pocket/vn/mesh-view";
import { encodeNovelMesh, encodeNovelMeshEffect } from "@pocket/vn";
function App() {
 const [phase, setPhase] = createSignal(0);
 const changed = () => phase() === 1;
 let mask = 0, art = 0;
 const geometry = (right, repeat=false) => encodeNovelMesh({ vertices: [10,10,repeat?-.25:0,0, right,10,repeat?1.25:1,0, 10,160,0,1], indices:[0,1,2] });
 const result = <View class="w-full h-full bg-[#08151D]">
  <NovelMeshView src="mesh.svg" geometry={geometry(changed() ? 100 : 70)} style={{opacity:0}} class="absolute left-0 top-0 w-[180] h-[180]" onNode={id=>{mask=id;}}/>
  <NovelMeshView src="mesh.svg" geometry={geometry(150,phase()===3)} class="absolute left-0 top-0 w-[180] h-[180]" onNode={id=>{art=id;}}/>
  <Focusable class="absolute left-0 top-[200] w-[180] h-[80] bg-[#273B44]" onPress={()=>setPhase((phase()+1)%4)}/>
 </View>;
 createRenderEffect(()=>{
  const data=phase()===2 ? new Uint8Array(0) : encodeNovelMeshEffect(phase()===3 ? {blend:"normal",repeatTexture:true} : {blend:changed()?"screen":"normal",masks:["mask"],inverted:changed()},()=>mask);
  if(!getOps().setMeshEffect(art,data)) throw new Error("MFX1 was refused");
 });
 return result;
}
mount(App);
`);
    const result = await buildGuest({ projectRoot: project, outDir: join(project, "out") });
    const metadata = JSON.parse(readFileSync(result.metadata, "utf8"));
    session = new NativeSession({ bytecodePath: result.bytecode, pakPath: result.pak, metadataPath: result.metadata, runtimeAbi: metadata.runtimeAbi }, { width: 200, height: 320 });
    const check = (frame: Frame, changed: boolean) => {
      const ops = frame.ops ?? [];
      expect(ops.filter(op => op.type === "meshLayerBegin").map(op => op.color)).toEqual([changed ? 3 : 0]);
      expect(ops.filter(op => op.type === "meshMaskBegin").map(op => op.color)).toEqual([changed ? 1 : 0]);
      expect(ops.filter(op => op.type === "meshLayerRestore")).toHaveLength(1);
      const triangles = ops.filter(op => op.type === "textureTriangle");
      // One target, one mask read. The opacity-zero source is not also drawn.
      expect(triangles).toHaveLength(2);
      expect(triangles[1]?.points?.[1]?.x).toBe(changed ? 100 : 70);
    };
    check(await session.boot(), false);
    check(await session.tapPoint({ x: 90, y: 240 }), true);
    const cleared = await session.tapPoint({ x: 90, y: 240 });
    expect(cleared.ops?.filter(op => op.type.startsWith("mesh"))).toHaveLength(0);
    expect(cleared.ops?.filter(op => op.type === "textureTriangle")).toHaveLength(1);
    const repeated = await session.tapPoint({ x: 90, y: 240 });
    expect(repeated.ops?.filter(op => op.type.startsWith("mesh"))).toHaveLength(0);
    const triangle = repeated.ops?.find(op => op.type === "textureTriangle");
    expect(triangle?.repeatTexture).toBe(true);
    expect(triangle?.uvs?.[0]).toBe(-0.25);
    expect(triangle?.uvs?.[2]).toBe(1.25);
    check(await session.tapPoint({ x: 90, y: 240 }), false);
  } finally {
    await session?.quit();
    rmSync(project, { recursive: true, force: true });
  }
}, 120000);
