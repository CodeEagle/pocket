import { strict as assert } from "node:assert";
import { test } from "bun:test";
import { center, ProbeSession, textOf, textOps, type HostRequest, type Reply } from "./probe_session.ts";

// A fake studio.* provider serving the exact result shapes of the frozen
// contract (studio/docs/ARCHITECTURE.md). It is the Dart provider's stand-in
// only for this guest-level test; the provider itself is tested in Dart.
const files = [
  { path: "app.tsx", bytes: 40 },
  { path: "manifest.json", bytes: 20 },
  { path: "src/alpha.ts", bytes: 30 },
  { path: "src/deep/beta.ts", bytes: 10 },
];
const contents: Record<string, string> = {
  "app.tsx": "export const MARKER_APP_TSX = 1;\n",
  "src/alpha.ts": "export const MARKER_ALPHA = 2;\n",
};
const projects = [
  { id: "alpha-app", appId: "pocket.alpha", name: "Alpha", title: "Alpha 应用", version: "0.1.0", build: 1, tickHz: 60, template: "app" },
  { id: "beta-game", appId: "pocket.beta", name: "Beta", title: "Beta 游戏", version: "0.1.0", build: 1, tickHz: 60, template: "game" },
];

function responder(log: HostRequest[]) {
  return (request: HostRequest): Reply => {
    log.push(request);
    const { capability, params } = request;
    switch (capability) {
      case "studio.project.list": return { ok: true, result: { projects } };
      case "studio.fs.tree": return { ok: true, result: { files, revision: 1 } };
      case "studio.fs.read": {
        const content = contents[params.path];
        return content === undefined
          ? { ok: false, error: { code: "not_found", message: "file not found" } }
          : { ok: true, result: { path: params.path, content, bytes: content.length, revision: 1 } };
      }
      case "studio.project.create": return { ok: true, result: { ...projects[0], id: params.id, title: params.settings?.name ?? params.id } };
      default: return { ok: false, error: { code: "capability_unavailable", message: capability } };
    }
  };
}

test("Studio guest renders the project list, opens a project and expands folders by input", async () => {
  const log: HostRequest[] = [];
  const session = new ProbeSession(responder(log));
  try {
    await session.boot();
    let frame = await session.until((f) => textOf(f).includes("Alpha 应用"), "project list");
    const text = textOf(frame);
    assert.ok(text.includes("Beta 游戏"), text);
    assert.ok(text.includes("项目"), text);
    assert.equal(log[0]?.capability, "studio.project.list");
    const projectListFrame = textOf(frame);

    // Tap a project: frames change and the tree is requested through the capability.
    const tile = textOps(frame, "Alpha 应用")[0]!;
    const p = center(tile);
    await session.tap(p.x, p.y);
    frame = await session.until((f) => textOf(f).includes("app.tsx"), "file tree");
    assert.notEqual(textOf(frame), projectListFrame, "tapping a project must change the frame");
    const tree = textOf(frame);
    for (const name of ["app.tsx", "manifest.json", "▸ src"]) assert.ok(tree.includes(name), `${name} missing in\n${tree}`);
    assert.ok(!tree.includes("alpha.ts"), "collapsed folder must hide children");
    assert.deepEqual(log.filter((r) => r.capability === "studio.fs.tree").map((r) => r.params), [{ project: "alpha-app" }]);

    // Tap the folder: it expands.
    const folder = center(textOps(frame, "▸ src")[0]!);
    await session.tap(folder.x, folder.y);
    frame = await session.until((f) => textOf(f).includes("alpha.ts"), "expanded folder");
    assert.ok(textOf(frame).includes("▾ src"));
    assert.ok(textOf(frame).includes("▸ deep"));

    // Tap a file: the read-only viewer shows its text.
    const file = center(textOps(frame, "alpha.ts")[0]!);
    await session.tap(file.x, file.y);
    frame = await session.until((f) => textOf(f).includes("MARKER_ALPHA"), "file viewer");
    assert.ok(textOf(frame).includes("src/alpha.ts"));
    assert.deepEqual(log.filter((r) => r.capability === "studio.fs.read").map((r) => r.params), [{ project: "alpha-app", path: "src/alpha.ts" }]);

    // Tap the folder again: it collapses.
    const again = center(textOps(frame, "▾ src")[0]!);
    await session.tap(again.x, again.y);
    frame = await session.until((f) => !textOf(f).includes("▸ deep") && textOf(f).includes("▸ src"), "collapsed folder");
    // Only studio.* capabilities were ever requested.
    assert.ok(log.every((r) => r.capability.startsWith("studio.")), JSON.stringify(log.map((r) => r.capability)));
  } finally {
    session.kill();
  }
}, 60_000);

test("Studio guest shows structured capability errors instead of fake success", async () => {
  const log: HostRequest[] = [];
  const session = new ProbeSession((r) => (log.push(r), { ok: false, error: { code: "service_unreachable", message: "Studio service is not reachable" } }));
  try {
    await session.boot();
    const frame = await session.until((f) => textOf(f).includes("service_unreachable"), "error notice");
    assert.ok(textOf(frame).includes("Studio service is not reachable"));
    assert.ok(!textOf(frame).includes("Alpha"));
  } finally {
    session.kill();
  }
}, 60_000);
