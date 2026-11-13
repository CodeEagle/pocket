import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initProject } from "../../pocket.ts";

const clipboardPackage = join(import.meta.dir, "../../packages/pocket_clipboard");

function readScaffold(root: string): { pubspec: string; dart: string; manifest: Record<string, any>; editor: Record<string, any> } {
  return {
    pubspec: readFileSync(join(root, "flutter/pubspec.yaml"), "utf8"),
    dart: readFileSync(join(root, "flutter/lib/main.dart"), "utf8"),
    manifest: JSON.parse(readFileSync(join(root, "manifest.json"), "utf8")),
    editor: JSON.parse(readFileSync(join(root, "editor.json"), "utf8")),
  };
}

async function scaffold(name: string, options: Parameters<typeof initProject>[1]) {
  const root = mkdtempSync(join(tmpdir(), "pocket-clipboard-"));
  const previous = process.env.FLUTTER_BIN;
  process.env.FLUTTER_BIN = "/usr/bin/false";
  try {
    return { root, ...readScaffold(await initProject(join(root, name), options)) };
  } finally {
    if (previous === undefined) delete process.env.FLUTTER_BIN;
    else process.env.FLUTTER_BIN = previous;
  }
}

test("clipboard remains absent from the default scaffold", async () => {
  const s = await scaffold("standard", {});
  try {
    expect(s.pubspec).not.toContain("pocket_clipboard");
    expect(s.dart).not.toContain("PocketClipboardPlugin");
    expect(s.dart).not.toContain("clipboard.");
    expect(s.manifest.capabilities.optional.some((c: string) => c.startsWith("clipboard."))).toBe(false);
    expect(s.manifest.permissions.optional).not.toContain("clipboard.read");
    expect(s.editor.clipboard).toBe(false);
  } finally {
    rmSync(s.root, { recursive: true, force: true });
  }
});

test("--clipboard adds the package, factory, explicit grants, capabilities and permissions", async () => {
  expect(existsSync(clipboardPackage)).toBe(true);
  const s = await scaffold("clip", { clipboard: true });
  try {
    expect(s.pubspec).toContain("pocket_clipboard:");
    expect(s.pubspec).toContain("packages/pocket_clipboard");
    expect(s.pubspec).not.toContain("pocket_dio");
    expect(s.dart).toContain("package:pocket_clipboard/pocket_clipboard.dart");
    expect(s.dart).toContain("pluginFactories: [createClipboardPlugin]");
    expect(s.dart).toContain("PocketClipboardPlugin()");
    expect(s.dart).toContain("allowedPermissions: const {'clipboard.read', 'clipboard.write'}");
    expect(s.dart).toContain("removing 'clipboard.read'");
    expect(s.manifest.capabilities.optional).toEqual(expect.arrayContaining(["clipboard.readText", "clipboard.hasText", "clipboard.writeText"]));
    expect(s.manifest.permissions.optional).toEqual(expect.arrayContaining(["clipboard.read", "clipboard.write"]));
    expect(s.editor.clipboard).toBe(true);
  } finally {
    rmSync(s.root, { recursive: true, force: true });
  }
});

test("--clipboard composes with --dio and hardware", async () => {
  const s = await scaffold("combined", { clipboard: true, dio: true });
  const h = await scaffold("hw", { clipboard: true, dio: true, hardware: true });
  try {
    expect(s.pubspec).toContain("pocket_dio:");
    expect(s.pubspec).toContain("pocket_clipboard:");
    expect(s.dart).toContain("pluginFactories: [createDioPlugin, createClipboardPlugin]");
    expect(s.dart).toContain("allowedPermissions: const {'clipboard.read', 'clipboard.write', 'network'}");
    expect(s.dart.match(/PocketPlugin createClipboardPlugin/g)?.length).toBe(1);
    expect(s.manifest.capabilities.optional).toContain("dio.request");
    expect(s.manifest.capabilities.optional).toContain("clipboard.readText");
    expect(s.manifest.permissions.optional).toEqual(expect.arrayContaining(["network", "clipboard.read", "clipboard.write"]));
    expect(h.dart).toContain("allowedPermissions: {...HardwarePermissions.all, 'network', 'clipboard.read', 'clipboard.write'}");
  } finally {
    rmSync(s.root, { recursive: true, force: true });
    rmSync(h.root, { recursive: true, force: true });
  }
});

test("clipboard scaffolding is deterministic and adds no Android/iOS platform patch", async () => {
  const a = await scaffold("same", { clipboard: true });
  const b = await scaffold("same", { clipboard: true });
  try {
    expect(b.dart).toBe(a.dart);
    expect(b.pubspec).toBe(a.pubspec);
    expect(a.dart.match(/PocketClipboardPlugin\(\)/g)?.length).toBe(1);
    expect(a.pubspec.match(/pocket_clipboard:/g)?.length).toBe(1);
  } finally {
    rmSync(a.root, { recursive: true, force: true });
    rmSync(b.root, { recursive: true, force: true });
  }
});
