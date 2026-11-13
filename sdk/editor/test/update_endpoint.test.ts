import { expect, test } from "bun:test";
import { chooseUpdateHost, isLocalNetworkAddress, startUpdateEndpoint } from "../update_endpoint.ts";

test("Editor socket peers must be loopback or private/link-local addresses", () => {
  for (const address of ["127.0.0.1", "127.0.0.2", "10.0.0.2", "172.16.0.1", "172.31.255.254", "192.168.50.1", "169.254.1.2", "::1", "0:0:0:0:0:0:0:1", "fc00::1", "fd12:3456::1", "fe80::1%en0", "febf::1", "::ffff:192.168.50.1", "::ffff:7f00:1"]) {
    expect(isLocalNetworkAddress(address), address).toBe(true);
  }
  for (const address of ["8.8.8.8", "172.15.0.1", "172.32.0.1", "192.169.0.1", "0.0.0.0", "::", "2001:db8::1", "fc::1", "fe8::1", "fec0::1", "::ffff:8.8.8.8", "::ffff:808:808", "evil.example", "192.168.1.999", ""]) {
    expect(isLocalNetworkAddress(address), address).toBe(false);
  }
});

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
    const canonical = await fetch(`${endpoint.origin}/pocket/3.2.0/com.example.notes/stable/latest.json`);
    expect(await canonical.text()).toBe("signed bytes");
    const index = await fetch(`${endpoint.origin}/test/pocket/3.2.0/com.example.notes/latest.json`);
    expect(await index.text()).toBe("signed bytes");
    const prefixed = await fetch(`${endpoint.origin}/test/pocket/3.2.0/com.example.notes/0.1.0/latest.json`);
    expect(await prefixed.text()).toBe("signed bytes");
    const preview = await fetch(`${endpoint.origin}/preview/pocket/3.2.0/dev.pocket.studio.preview/preview/latest.json`);
    // WIP preview bytecode is loopback-only: the LAN version backend must not expose it.
    expect(preview.status).toBe(404);
    expect((await fetch(`${endpoint.origin}/preview/pocket/3.2.0/dev.pocket.studio.preview/preview/keys.json`)).status).toBe(404);
    const canonicalBundle = await fetch(`${endpoint.origin}/pocket/3.2.0/com.example.notes/stable/bundles/bundle-${"a".repeat(64)}.7z`);
    expect(await canonicalBundle.text()).toBe("signed bytes");
    const canonicalBlob = await fetch(`${endpoint.origin}/pocket/3.2.0/com.example.notes/stable/blobs/${"b".repeat(64)}`, { method: "HEAD" });
    expect(canonicalBlob.status).toBe(200);
    expect(await canonicalBlob.text()).toBe("");
    const head = await fetch(`${endpoint.origin}/updates/app/blobs/abcdef`, { method: "HEAD" });
    expect(head.status).toBe(200); expect(await head.text()).toBe("");
    for (const path of ["/health", "/api/projects", "/keys/app.json", "/updates/app/%2e%2e/%2e%2e/keys/app.json", "/updates/app/%252e%252e/key", "/updates/app/%5csecret", "/pocket/3.2.0/com.example.notes/stable/%2e%2e/keys/app.json", "/pocket/3.2.0/com.example.notes/stable/%252e%252e/key"]) {
      const denied = await fetch(endpoint.origin + path);
      expect(denied.status).toBe(404);
      expect(denied.headers.get("cache-control")).toBe("no-store");
    }
    expect((await fetch(`${endpoint.origin}/updates/app/latest.json`, { method: "POST" })).status).toBe(405);
    expect(reads).toEqual([
      "/updates/app/latest.json",
      "/pocket/3.2.0/com.example.notes/stable/latest.json",
      "/test/pocket/3.2.0/com.example.notes/latest.json",
      "/test/pocket/3.2.0/com.example.notes/0.1.0/latest.json",
      "/pocket/3.2.0/com.example.notes/stable/bundles/bundle-" + "a".repeat(64) + ".7z",
      "/pocket/3.2.0/com.example.notes/stable/blobs/" + "b".repeat(64),
      "/updates/app/blobs/abcdef",
    ]);
  } finally { endpoint.stop(); }
  await expect(fetch(`${endpoint.origin}/updates/app/latest.json`)).rejects.toThrow();
});
