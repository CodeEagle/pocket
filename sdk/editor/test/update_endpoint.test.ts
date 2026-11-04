import { expect, test } from "bun:test";
import { chooseUpdateHost, startUpdateEndpoint } from "../update_endpoint.ts";

test("device update host selects LAN and rejects loopback-only interfaces", () => {
  const entry = (address: string, internal = false) => ({ address, internal, family: "IPv4" } as any);
  expect(chooseUpdateHost({ lo0: [entry("127.0.0.1", true)], bridge0: [entry("172.20.1.1")], en1: [entry("192.168.50.230")] })).toBe("192.168.50.230");
  expect(() => chooseUpdateHost({ lo0: [entry("127.0.0.1", true)] })).toThrow("No LAN IPv4");
});

test("device update endpoint serves only read-only published paths and closes its listener", async () => {
  const reads: string[] = [];
  const endpoint = startUpdateEndpoint({ hostname: "127.0.0.1", port: 0,
    read: async path => { reads.push(path); return new Response("signed bytes"); } });
  try {
    const response = await fetch(`${endpoint.origin}/updates/app/latest.json`);
    expect(await response.text()).toBe("signed bytes");
    expect(response.headers.get("cache-control")).toBe("no-store");
    const head = await fetch(`${endpoint.origin}/updates/app/blobs/abcdef`, { method: "HEAD" });
    expect(head.status).toBe(200); expect(await head.text()).toBe("");
    for (const path of ["/health", "/api/projects", "/keys/app.json", "/updates/app/%2e%2e/%2e%2e/keys/app.json", "/updates/app/%252e%252e/key", "/updates/app/%5csecret"]) {
      const denied = await fetch(endpoint.origin + path);
      expect(denied.status).toBe(404);
      expect(denied.headers.get("cache-control")).toBe("no-store");
    }
    expect((await fetch(`${endpoint.origin}/updates/app/latest.json`, { method: "POST" })).status).toBe(405);
    expect(reads).toEqual(["/updates/app/latest.json", "/updates/app/blobs/abcdef"]);
  } finally { endpoint.stop(); }
  await expect(fetch(`${endpoint.origin}/updates/app/latest.json`)).rejects.toThrow();
});
