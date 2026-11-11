import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createFileDiagnostics } from "../packages/pocket_diagnostics/src/node.ts";
import type { DiagnosticQuery } from "../packages/pocket_diagnostics/src/types.ts";

/** One bounded workspace journal; project identities are query filters, never paths. */
export function createStudioDiagnostics(workspaceRoot: string) {
  return createFileDiagnostics({
    directory: join(workspaceRoot, "diagnostics"),
    context: { source: "studio", sessionId: randomUUID() },
    maxRecords: 2000,
    maxFileBytes: 1024 * 1024,
    maxRotatedFiles: 3,
  });
}

export async function handleDiagnosticsRequest(
  diagnostics: ReturnType<typeof createStudioDiagnostics>,
  request: Request,
  projectId: string,
  revision?: number,
): Promise<Response> {
  const url = new URL(request.url);
  const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), {
    status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
  if (request.method === "GET") {
    const kind = url.searchParams.get("kind");
    if (kind !== null && kind !== "log" && kind !== "crash") return json({ error: "invalid diagnostic kind" }, 422);
    const query: DiagnosticQuery = { projectId, ...(kind ? { kind } : {}), order: "desc", limit: 2000 };
    const bundle = await diagnostics.exportRecords(query);
    if (url.searchParams.get("download") === "1") return new Response(JSON.stringify(bundle, null, 2), {
      headers: {
        "content-type": "application/json; charset=utf-8", "cache-control": "no-store",
        "content-disposition": `attachment; filename="${projectId}-diagnostics.json"`,
      },
    });
    return json(bundle);
  }
  if (request.method !== "POST") return json({ error: "method not allowed" }, 405);
  const raw = await request.text();
  if (Buffer.byteLength(raw) > 64 * 1024) return json({ error: "diagnostic report exceeds 64 KiB" }, 413);
  let body: Record<string, unknown>;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    body = parsed;
  } catch { return json({ error: "diagnostic report must be a JSON object" }, 422); }
  if (body.kind !== "log" && body.kind !== "crash") return json({ error: "invalid diagnostic kind" }, 422);
  if (typeof body.message !== "string" || !body.message.trim()) return json({ error: "diagnostic message is required" }, 422);
  // Browser reports cannot impersonate the native collector or another project/session.
  const context = { projectId, revision, source: "studio.browser", data: body.data };
  const record = body.kind === "crash"
    ? await diagnostics.recordCrash({ ...context, message: body.message, error: body.error ?? body.message, unhandled: body.unhandled === true })
    : await diagnostics.recordLog({ ...context, message: body.message, severity: "error" });
  return json({ id: record.id }, 201);
}
