import { networkInterfaces } from "node:os";
import { isIP } from "node:net";

function privateIPv4(address: string): boolean {
  if (isIP(address) !== 4) return false;
  const [a, b] = address.split(".").map(Number);
  return a === 10 || (a === 172 && b! >= 16 && b! <= 31) || (a === 192 && b === 168);
}

/** Classify the actual socket peer, never a forwarded or Host header. */
export function isLocalNetworkAddress(address: string): boolean {
  if (isIP(address) === 4) {
    return privateIPv4(address) || address.startsWith("127.") || address.startsWith("169.254.");
  }
  if (isIP(address) !== 6) return false;
  const host = new URL(`http://[${address.split("%")[0]}]`).hostname.toLowerCase();
  if (host === "[::1]" || /^\[(?:f[cd][0-9a-f]{2}|fe[89ab][0-9a-f]):/.test(host)) return true;
  // URL canonicalization turns both dotted and hexadecimal mapped IPv4 into
  // this form, so a public IPv4 cannot bypass the IPv4 check via IPv6.
  const mapped = /^\[::ffff:([0-9a-f]+):([0-9a-f]+)\]$/.exec(host);
  if (!mapped) return false;
  const high = parseInt(mapped[1]!, 16), low = parseInt(mapped[2]!, 16);
  return isLocalNetworkAddress(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`);
}

const legacyUpdatePathPattern = /^\/updates\/[a-z][a-z0-9-]{0,47}\/.+/;
const packageIndexPathPattern = /^(?:\/(?:test|stable|preview))?\/pocket\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}\/latest\.json$/;
const canonicalUpdatePathPattern =
  /^(?:\/(?:test|stable|preview))?\/pocket\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}\/.+/;
const safePathSegmentPattern = /^[A-Za-z0-9_.-]+$/;

function isPublishedPath(path: string): boolean {
  if (path.includes("%")) return false;
  const parts = path.split("/").slice(1);
  if (!parts.every((part) => part.length > 0 && part !== "." && part !== ".." && safePathSegmentPattern.test(part))) return false;
  if (legacyUpdatePathPattern.test(path)) return true;
  if (packageIndexPathPattern.test(path)) return true;
  if (!canonicalUpdatePathPattern.test(path)) return false;
  // A canonical release route may only expose public artifact roots. This
  // extra check also prevents a URL-normalized encoded `..` segment from
  // becoming an apparently valid release path before the callback sees it.
  const canonicalOffset = (parts[0] === "test" || parts[0] === "stable" || parts[0] === "preview") && parts[1] === "pocket" ? 1 : 0;
  const artifactRoot = parts[canonicalOffset + 4];
  return artifactRoot !== undefined && new Set([
    "latest.json",
    "signed-manifest.json",
    "payload.json",
    "host.json",
    "bundle.7z",
    "bundle.zip",
    "bundles",
    "blobs",
    "bootstrap",
    "assets",
  ]).has(artifactRoot);
}

/** Prefer a physical LAN interface over virtual bridges; never advertise loopback. */
export function chooseUpdateHost(interfaces = networkInterfaces()): string {
  const candidates = Object.entries(interfaces).flatMap(([name, entries]) =>
    (entries ?? []).filter(entry => !entry.internal && entry.family === "IPv4" && privateIPv4(entry.address))
      .map(entry => ({ name, address: entry.address })));
  candidates.sort((a, b) => Number(!/^(en\d|eth\d|wi-?fi|ethernet|wlan\d)/i.test(a.name)) -
    Number(!/^(en\d|eth\d|wi-?fi|ethernet|wlan\d)/i.test(b.name)));
  if (!candidates[0]) throw new Error("No LAN IPv4 for device updates; connect to a LAN or set POCKET_EDITOR_UPDATE_HOST to a local LAN IPv4");
  return candidates[0].address;
}

/** Published artifacts only. Editor APIs and signing material have no route here. */
export function startUpdateEndpoint(options: {
  hostname: string;
  port: number;
  read: (path: string, servingOrigin: string) => Promise<Response>;
}): { origin: string; stop: () => void } {
  if (!privateIPv4(options.hostname) && options.hostname !== "127.0.0.1") {
    throw new Error("Device update host must be a local private IPv4 address");
  }
  if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535) {
    throw new Error("Device update port must be between 0 and 65535");
  }
  const server = Bun.serve({
    hostname: options.hostname, port: options.port,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (!['GET', 'HEAD'].includes(request.method)) return new Response("Method not allowed", { status: 405, headers: { allow: "GET, HEAD", "cache-control": "no-store" } });
      if (!isPublishedPath(path)) {
        return new Response("Not found", { status: 404, headers: { "cache-control": "no-store" } });
      }
      try {
        const response = await options.read(path, new URL(request.url).origin);
        const headers = new Headers(response.headers);
        headers.set("cache-control", "no-store");
        headers.set("x-content-type-options", "nosniff");
        return new Response(request.method === 'HEAD' ? null : response.body, { status: response.status, headers });
      } catch {
        return new Response("Not found", { status: 404, headers: { "cache-control": "no-store" } });
      }
    },
  });
  return { origin: `http://${options.hostname}:${server.port}`, stop: () => { void server.stop(true); } };
}
