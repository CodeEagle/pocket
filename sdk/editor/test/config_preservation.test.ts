import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startEditor } from "../server.ts";

function temporaryDirectory(): string {
  return mkdtempSync(join(tmpdir(), "pocket-editor-config-"));
}

async function request(server: ReturnType<typeof Bun.serve>, path: string, init?: RequestInit): Promise<{ response: Response; value: any }> {
  const headers = new Headers(init?.headers);
  if ((init?.method ?? "GET").toUpperCase() !== "GET") headers.set("x-pocket-editor", "1");
  const response = await fetch(`http://${server.hostname}:${server.port}${path}`, { ...init, headers });
  return { response, value: await response.json() };
}

test("Editor preserves Pocket manifest identity and custom app fields across config PUT", async () => {
  const workspace = temporaryDirectory();
  const project = temporaryDirectory();
  writeFileSync(join(project, "pocket.json"), JSON.stringify({
    $schema: "https://pocketjs.dev/schema/pocket-2.json",
    pocket: 2,
    id: "dev.example.showcase",
    name: "showcase-app",
    title: "Showcase Human Name",
    version: "0.1.0",
    engine: { capabilities: { requires: ["text.glyphs.baked"], enhances: [] }, customEngineField: "keep" },
    customTopLevel: { retain: true },
    app: {
      entry: "src/main.tsx",
      output: "showcase-app",
      framework: "solid",
      viewport: { fixed: { logical: [360, 640], presentation: "native" } },
      customAppField: { retain: true },
    },
  }, null, 2));
  writeFileSync(join(project, "editor.json"), JSON.stringify({
    id: "showcase-app", appId: "dev.example.showcase", name: "Stale Editor Name", title: "Stale Editor Title",
    version: "2.4.0", build: 7, tickHz: 72, entry: "app.tsx", framework: "solid", editorCustomField: "retain",
  }, null, 2));
  mkdirSync(join(project, "src"), { recursive: true });
  writeFileSync(join(project, "src/main.tsx"), "export const showcase = true;\n");
  writeFileSync(join(project, "manifest.json"), JSON.stringify({ protocolVersion: 1, capabilities: { requires: [], optional: [] } }));

  const server = await startEditor({ port: 0, workspace, projectRoot: project });
  try {
    const loaded = await request(server, "/api/projects/showcase-app/config");
    expect(loaded.response.status).toBe(200);
    expect(loaded.value.name).toBe("Showcase Human Name");
    expect(loaded.value.title).toBe("Showcase Human Name");
    expect(loaded.value.version).toBe("2.4.0");
    expect(loaded.value.build).toBe(7);
    expect(loaded.value.entry).toBe("src/main.tsx");
    expect(loaded.value.output).toBe("showcase-app");

    const updated = await request(server, "/api/projects/showcase-app/config", {
      method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Renamed Showcase" }),
    });
    expect(updated.response.status).toBe(200);
    expect(updated.value.name).toBe("Renamed Showcase");
    expect(updated.value.title).toBe("Renamed Showcase");
    expect(updated.value.appId).toBe("dev.example.showcase");
    expect(updated.value.version).toBe("2.4.0");
    expect(updated.value.build).toBe(7);
    expect(updated.value.tickHz).toBe(72);
    expect(updated.value.entry).toBe("src/main.tsx");
    expect(updated.value.output).toBe("showcase-app");

    const writtenPocket = JSON.parse(readFileSync(join(project, "pocket.json"), "utf8"));
    expect(writtenPocket.name).toBe("showcase-app");
    expect(writtenPocket.title).toBe("Renamed Showcase");
    expect(writtenPocket.app.entry).toBe("src/main.tsx");
    expect(writtenPocket.app.output).toBe("showcase-app");
    expect(writtenPocket.app.customAppField).toEqual({ retain: true });
    expect(writtenPocket.customTopLevel).toEqual({ retain: true });
    const writtenEditor = JSON.parse(readFileSync(join(project, "editor.json"), "utf8"));
    expect(writtenEditor.editorCustomField).toBe("retain");
    expect(writtenEditor.entry).toBe("src/main.tsx");
  } finally {
    server.stop(true);
    rmSync(workspace, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  }
});

test("new Editor projects use the project id as the Pocket slug", async () => {
  const workspace = temporaryDirectory();
  const server = await startEditor({ port: 0, workspace });
  try {
    const created = await request(server, "/api/projects", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: "new-showcase", name: "New Showcase" }),
    });
    expect(created.response.status).toBe(201);
    const pocket = JSON.parse(readFileSync(join(workspace, "projects/new-showcase/pocket.json"), "utf8"));
    expect(pocket.name).toMatch(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/);
    expect(pocket.name).toBe("new-showcase");
    expect(pocket.title).toBe("New Showcase");
  } finally {
    server.stop(true);
    rmSync(workspace, { recursive: true, force: true });
  }
});
