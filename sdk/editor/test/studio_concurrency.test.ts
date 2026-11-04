import { expect, test } from "bun:test";
import { connect } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startEditor } from "../server.ts";

function temporaryWorkspace(): string {
  return mkdtempSync(join(tmpdir(), "pocket-editor-concurrency-"));
}

async function request(server: ReturnType<typeof Bun.serve>, path: string, init: RequestInit = {}): Promise<{ response: Response; value: any }> {
  const headers = new Headers(init.headers);
  const method = (init.method ?? "GET").toUpperCase();
  if (["POST", "PUT", "PATCH", "DELETE"].includes(method) && !headers.has("x-pocket-editor")) headers.set("x-pocket-editor", "1");
  const response = await fetch(`http://${server.hostname}:${server.port}${path}`, { ...init, headers });
  const type = response.headers.get("content-type") ?? "";
  const value = type.includes("application/json") ? await response.json() : await response.text();
  return { response, value };
}

type RawResponse = { status: number; body: string };

/** Send headers and a deliberately incomplete body over a real TCP socket. */
async function openSlowJsonPut(server: ReturnType<typeof Bun.serve>, path: string, body: string): Promise<{ finish: () => Promise<RawResponse> }> {
  const socket = connect({ host: server.hostname, port: server.port });
  const bytes = Buffer.from(body);
  let responseBuffer = Buffer.alloc(0);
  let responseEnded = false;
  let finished = false;
  let responseResolve!: (response: RawResponse) => void;
  let responseReject!: (error: Error) => void;
  const responsePromise = new Promise<RawResponse>((resolve, reject) => {
    responseResolve = resolve;
    responseReject = reject;
  });

  const parseResponse = (): void => {
    const headerEnd = responseBuffer.indexOf("\r\n\r\n");
    if (headerEnd < 0) return;
    const headerText = responseBuffer.subarray(0, headerEnd).toString("latin1");
    const status = Number(headerText.match(/^HTTP\/\d(?:\.\d)?\s+(\d+)/m)?.[1] ?? 0);
    const contentLength = Number(headerText.match(/^content-length:\s*(\d+)/im)?.[1] ?? -1);
    if (contentLength >= 0 && !responseEnded && responseBuffer.length < headerEnd + 4 + contentLength) return;
    if (contentLength < 0 && !responseEnded) return;
    responseResolve({ status, body: responseBuffer.subarray(headerEnd + 4, contentLength >= 0 ? headerEnd + 4 + contentLength : undefined).toString("utf8") });
    socket.destroy();
  };

  socket.setTimeout(5000, () => {
    responseReject(new Error("slow request response timed out"));
    socket.destroy();
  });
  socket.on("end", () => {
    responseEnded = true;
    parseResponse();
  });
  socket.once("error", (error) => responseReject(error instanceof Error ? error : new Error(String(error))));
  socket.on("data", (chunk) => {
    responseBuffer = Buffer.concat([responseBuffer, Buffer.from(chunk)]);
    parseResponse();
  });
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", () => resolve());
    socket.once("error", reject);
  });

  const header = [
    `PUT ${path} HTTP/1.1`,
    `Host: ${server.hostname}:${server.port}`,
    "Connection: close",
    "x-pocket-editor: 1",
    "content-type: application/json",
    `content-length: ${bytes.byteLength}`,
    "",
    "",
  ].join("\r\n");
  socket.write(header);
  // A single opening brace is enough for Bun to expose the Request while its
  // body parser is still awaiting the declared content length.
  socket.write(bytes.subarray(0, 1));

  return {
    finish: async () => {
      if (finished) return responsePromise;
      finished = true;
      await new Promise<void>((resolve, reject) => {
        socket.write(bytes.subarray(1), (error?: Error) => error ? reject(error) : resolve());
      });
      return responsePromise;
    },
  };
}

async function waitForLease(server: ReturnType<typeof Bun.serve>, projectId: string): Promise<void> {
  const deadline = Date.now() + 100;
  while (Date.now() < deadline) {
    const conflict = await request(server, `/api/projects/${projectId}/config`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ appId: "pocket.lease", name: "Lease Probe", version: "0.1.0", build: 1, tickHz: 60 }),
    });
    if (conflict.response.status === 409) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("project write lease was not visible within 100ms");
}

test("project write lease rejects concurrent mutations before their tools run", async () => {
  const workspace = temporaryWorkspace();
  let buildCalls = 0;
  const server = await startEditor({
    port: 0,
    workspace,
    buildRunner: async () => {
      buildCalls += 1;
      throw new Error("build runner must not be reached by a lease conflict");
    },
  });
  let slowRequest: { finish: () => Promise<RawResponse> } | undefined;
  try {
    const created = await request(server, "/api/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "lease-app", name: "Lease App", appId: "pocket.lease", version: "0.1.0", tickHz: 60 }),
    });
    expect(created.response.status).toBe(201);

    const nextSource = JSON.stringify({ source: "export default function LeaseApp() { return <text>lease</text>; }\n" });
    slowRequest = await openSlowJsonPut(server, "/api/projects/lease-app/source", nextSource);
    await waitForLease(server, "lease-app");

    const [config, deploy, codex] = await Promise.all([
      request(server, "/api/projects/lease-app/config", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ appId: "pocket.lease", name: "Concurrent Config", version: "0.1.0", build: 1, tickHz: 60 }),
      }),
      request(server, "/api/projects/lease-app/deploy", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ deviceId: "not-started" }),
      }),
      request(server, "/api/projects/lease-app/codex/turn", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "do not start while source is being written" }),
      }),
    ]);
    expect(config.response.status).toBe(409);
    expect(deploy.response.status).toBe(409);
    expect(codex.response.status).toBe(409);
    expect(buildCalls).toBe(0);

    const completed = await slowRequest.finish();
    slowRequest = undefined;
    expect(completed.status).toBe(200);

    const afterLease = await request(server, "/api/projects/lease-app/config", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ appId: "pocket.lease", name: "After Lease", version: "0.1.1", build: 2, tickHz: 60 }),
    });
    expect(afterLease.response.status).toBe(200);
    expect(afterLease.value.name).toBe("After Lease");
  } finally {
    if (slowRequest) {
      try { await slowRequest.finish(); } catch { /* the server may have closed it */ }
    }
    server.stop(true);
    rmSync(workspace, { recursive: true, force: true });
  }
});
