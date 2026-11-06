import { expect, test } from "bun:test";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startEditor } from "../server.ts";

function temporaryWorkspace(): string {
  return mkdtempSync(join(tmpdir(), "pocket-editor-templates-"));
}

async function request(server: ReturnType<typeof Bun.serve>, path: string, init?: RequestInit): Promise<{ response: Response; value: any }> {
  const headers = new Headers(init?.headers);
  if ((init?.method ?? "GET").toUpperCase() !== "GET") headers.set("x-pocket-editor", "1");
  const response = await fetch(`http://${server.hostname}:${server.port}${path}`, { ...init, headers });
  const contentType = response.headers.get("content-type") ?? "";
  return { response, value: contentType.includes("application/json") ? await response.json() : await response.text() };
}

test("Editor creates app and game projects from their selected templates", async () => {
  const workspace = temporaryWorkspace();
  const server = await startEditor({ port: 0, workspace });
  try {
    const app = await request(server, "/api/projects", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "template-app", name: "Template App" }),
    });
    expect(app.response.status).toBe(201);
    expect(app.value.template).toBe("app");
    expect(JSON.parse(readFileSync(join(workspace, "projects/template-app/editor.json"), "utf8")).template).toBe("app");
    expect(readFileSync(join(workspace, "projects/template-app/app.tsx"), "utf8")).toContain("App");

    const game = await request(server, "/api/projects", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "template-game", name: "Template Game", template: "game" }),
    });
    expect(game.response.status).toBe(201);
    expect(game.value.template).toBe("game");
    expect(JSON.parse(readFileSync(join(workspace, "projects/template-game/editor.json"), "utf8")).template).toBe("game");
    expect(readFileSync(join(workspace, "projects/template-game/app.tsx"), "utf8")).toContain("Game");
  } finally {
    server.stop(true);
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("Editor rejects an unknown template before creating a project directory", async () => {
  const workspace = temporaryWorkspace();
  const server = await startEditor({ port: 0, workspace });
  try {
    const result = await request(server, "/api/projects", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "template-invalid", name: "Invalid", template: "unknown" }),
    });
    expect(result.response.status).toBe(400);
    expect(existsSync(join(workspace, "projects/template-invalid"))).toBe(false);
  } finally {
    server.stop(true);
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("a configured external project remains selectable alongside new workspace projects", async () => {
  const workspace = temporaryWorkspace();
  const external = temporaryWorkspace();
  cpSync(join(import.meta.dir, "../../templates/app"), external, { recursive: true });
  writeFileSync(join(external, "editor.json"), JSON.stringify({ id: "external-app", name: "External App" }));
  const server = await startEditor({ port: 0, workspace, projectRoot: external });
  try {
    const created = await request(server, "/api/projects", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "new-game", name: "New Game", template: "game" }),
    });
    expect(created.response.status).toBe(201);
    const listed = await request(server, "/api/projects");
    expect(listed.value.map((project: any) => project.id).sort()).toEqual(["external-app", "new-game"]);
    expect((await request(server, "/api/projects/new-game/config")).value.template).toBe("game");
    expect((await request(server, "/api/projects/external-app/config")).response.status).toBe(200);
  } finally {
    server.stop(true);
    rmSync(workspace, { recursive: true, force: true });
    rmSync(external, { recursive: true, force: true });
  }
});
