// Small pure helpers shared by the publish / artifacts / versions pages.

export const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
export const str = (value: unknown): string | undefined => (typeof value === "string" && value.length > 0 ? value : undefined);
export const num = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) ? value : undefined);
export const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} 字节`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MiB`;
}

/** `abcdef0123…89abcd`: enough to recognise a digest on screen; the copy button copies the whole value. */
export function shortHash(hash: string, head = 12, tail = 6): string {
  return hash.length <= head + tail + 1 ? hash : `${hash.slice(0, head)}…${hash.slice(-tail)}`;
}

export function originOf(url: string | undefined): string | undefined {
  const match = url ? /^(https?:\/\/[^/?#]+)/.exec(url) : null;
  return match ? match[1] : undefined;
}

/** Joins a service-relative path (`/releases/x.tar.gz`) with the service origin; absolute URLs pass through. */
export function absoluteUrl(url: string | undefined, origin: string | undefined): string | undefined {
  if (!url) return undefined;
  if (/^https?:\/\//.test(url)) return url;
  return origin && url.startsWith("/") ? `${origin}${url}` : url;
}

/** `2026-11-13 10:20:30 UTC` from an ISO timestamp (no Intl in the guest). */
export function formatTime(iso: string | undefined): string | undefined {
  if (!iso) return undefined;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? iso : `${new Date(t).toISOString().replace("T", " ").slice(0, 19)} UTC`;
}
