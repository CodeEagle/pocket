/** Loopback-only static server for signed Pocket update artifacts. */
import { existsSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

export type PocketUpdateServerOptions = {
  rootDir: string;
  port?: number;
  adbReverse?: boolean;
  device?: string;
};
export type PocketUpdateServer = {
  url: string;
  port: number;
  hostname: string;
  stop: (closeActiveConnections?: boolean) => void;
};

const HOST = "127.0.0.1";

function inside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function safeFile(rootDir: string, pathname: string): string | undefined {
  let decoded: string;
  try { decoded = decodeURIComponent(pathname); } catch { return undefined; }
  const requested = decoded === "/latest.json" && !existsSync(join(rootDir, "latest.json"))
    ? "/signed-manifest.json" : decoded;
  const allowed = requested === "/latest.json" || requested === "/signed-manifest.json" || requested === "/payload.json" || /^\/blobs\/[a-f0-9]{64}$/.test(requested);
  if (!allowed) return undefined;
  const root = realpathSync(rootDir);
  const candidate = resolve(root, `.${requested}`);
  if (!inside(root, candidate)) return undefined;
  if (existsSync(candidate)) {
    let target: string;
    try { target = realpathSync(candidate); } catch { return undefined; }
    if (!inside(root, target)) return undefined;
  }
  return candidate;
}

export function adbReverseCommand(port: number, device?: string): string[] {
  if (!device || device.trim().length === 0) throw new Error("adb reverse requires --device/-s (refusing implicit device selection)");
  return ["adb", "-s", device, "reverse", `tcp:${port}`, `tcp:${port}`];
}

export function serveUpdates(options: PocketUpdateServerOptions): PocketUpdateServer {
  const rootDir = realpathSync(resolve(options.rootDir));
  const server = Bun.serve({
    hostname: HOST,
    port: options.port ?? 8787,
    async fetch(request) {
      if (request.method !== "GET" && request.method !== "HEAD") return new Response("Method Not Allowed", { status: 405, headers: { Allow: "GET, HEAD" } });
      const url = new URL(request.url);
      const filePath = safeFile(rootDir, url.pathname);
      if (!filePath) return new Response("Not Found", { status: 404 });
      const file = Bun.file(filePath);
      if (!await file.exists()) return new Response("Not Found", { status: 404 });
      const manifest = url.pathname === "/latest.json" || url.pathname === "/signed-manifest.json" || url.pathname === "/payload.json";
      const headers = new Headers({ "Access-Control-Allow-Origin": "*", "Content-Type": url.pathname.endsWith(".json") ? "application/json; charset=utf-8" : "application/octet-stream", "Cache-Control": manifest ? "no-store" : "public, max-age=31536000, immutable" });
      return request.method === "HEAD" ? new Response(null, { status: 200, headers }) : new Response(file, { headers });
    },
  });
  if (options.adbReverse) {
    let command: string[];
    try { command = adbReverseCommand(server.port, options.device); } catch (error) { server.stop(true); throw error; }
    const result = Bun.spawnSync(command, { stdout: "pipe", stderr: "pipe" });
    if (result.exitCode !== 0) { server.stop(true); throw new Error(`adb reverse failed: ${new TextDecoder().decode(result.stderr).trim()}`); }
  }
  return server as unknown as PocketUpdateServer;
}

export const servePocketUpdates = serveUpdates;

if (import.meta.main) {
  const args = process.argv.slice(2);
  const rootIndex = args.indexOf("--root");
  const rootDir = rootIndex >= 0 ? args[rootIndex + 1] : undefined;
  const portIndex = args.indexOf("--port");
  const port = portIndex >= 0 ? Number(args[portIndex + 1]) : 8787;
  if (!rootDir || !Number.isInteger(port) || port < 0 || port > 65535) throw new Error("usage: bun scripts/serve_updates.ts --root DIR [--port N]");
  const server = serveUpdates({ rootDir, port });
  console.log(`Pocket updates: ${server.url} (manifest: ${server.url}latest.json)`);
}
