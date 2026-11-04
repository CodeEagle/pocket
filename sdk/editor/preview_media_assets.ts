/** Local video bytes for the existing native-frame browser preview.
 * Layout and playback intent remain in PocketJS; this module only serves
 * project assets. Streaming a verified file descriptor avoids buffering a
 * whole MP4 and keeps a later path replacement from changing the opened file.
 */
import { constants } from "node:fs";
import { lstat, open, realpath, stat } from "node:fs/promises";
import { resolve, relative, sep, extname } from "node:path";
import { Readable } from "node:stream";

const videoTypes: Record<string, string> = {
  ".mp4": "video/mp4", ".m4v": "video/mp4", ".webm": "video/webm",
  ".mov": "video/quicktime", ".ogv": "video/ogg",
};
function failure(status: number, message: string): Response {
  return new Response(message, { status, headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" } });
}
function inside(root: string, path: string): boolean {
  const value = relative(root, path);
  return value !== ".." && !value.startsWith(`..${sep}`) && !value.startsWith(sep);
}

export async function servePreviewMedia(request: Request, projectDirectory: string, logicalAsset: string): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") return failure(405, "method not allowed");
  const pieces = logicalAsset.split("/");
  if (pieces[0] !== "assets" || pieces.length < 2 || pieces.some((part) => !part || part === "." || part === ".." || /[\\\u0000:]/.test(part))) {
    return failure(400, "invalid media asset path");
  }
  const contentType = videoTypes[extname(logicalAsset).toLowerCase()];
  if (!contentType) return failure(415, "unsupported video asset");
  let file: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const root = await realpath(projectDirectory);
    let candidate = root;
    for (const piece of pieces) {
      candidate = resolve(candidate, piece);
      if ((await lstat(candidate)).isSymbolicLink()) return failure(403, "media symlinks are not allowed");
    }
    const canonical = await realpath(candidate);
    if (!inside(root, canonical)) return failure(403, "media asset escapes project");
    const expected = await stat(canonical);
    if (!expected.isFile()) return failure(404, "media asset not found");
    file = await open(canonical, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = await file.stat();
    if (!opened.isFile() || opened.ino !== expected.ino || opened.dev !== expected.dev) {
      await file.close(); file = undefined;
      return failure(403, "media asset changed while opening");
    }
    const size = opened.size;
    const headers = new Headers({ "content-type": contentType, "accept-ranges": "bytes", "cache-control": "no-store", "x-content-type-options": "nosniff" });
    let start = 0, end = size - 1, status = 200;
    const range = request.headers.get("range");
    if (request.method === "GET" && range !== null) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range);
      let valid = !!match && !!(match[1] || match[2]) && size > 0;
      if (valid && match) {
        if (!match[1]) {
          const suffix = Number(match[2]);
          valid = Number.isSafeInteger(suffix) && suffix > 0;
          start = Math.max(0, size - suffix);
        } else {
          start = Number(match[1]);
          end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
          valid = Number.isSafeInteger(start) && Number.isSafeInteger(Number(match[2] || end)) && start < size && start <= end;
        }
      }
      if (!valid) {
        await file.close(); file = undefined;
        headers.set("content-range", `bytes */${size}`);
        return new Response(null, { status: 416, headers });
      }
      status = 206;
      headers.set("content-range", `bytes ${start}-${end}/${size}`);
    }
    headers.set("content-length", String(Math.max(0, end - start + 1)));
    if (request.method === "HEAD" || size === 0) {
      await file.close(); file = undefined;
      return new Response(null, { status, headers });
    }
    const stream = file.createReadStream({ start, end, autoClose: true });
    file = undefined; // stream now owns the verified descriptor, including cancellation
    return new Response(Readable.toWeb(stream) as ReadableStream<Uint8Array>, { status, headers });
  } catch (error) {
    if (file) await file.close().catch(() => {});
    const code = (error as NodeJS.ErrnoException).code;
    return failure(code === "ENOENT" || code === "ENOTDIR" ? 404 : 403, "media asset unavailable");
  }
}
