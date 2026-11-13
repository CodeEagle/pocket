import { expect, test } from "bun:test";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  generatePluginTypes,
  generatePluginTypesReport,
  PluginTypesError,
} from "../plugin_types.ts";

const fixturePath = resolve(import.meta.dir, "fixtures/plugin-descriptors.json");

function fixture(): unknown {
  return JSON.parse(readFileSync(fixturePath, "utf8")) as unknown;
}
test("plugin type generation is deterministic and uses only registered capabilities", () => {
  const input = fixture();
  const first = generatePluginTypes(input);
  const second = generatePluginTypes(input);
  expect(first).toBe(second);
  expect(first).toContain('readonly "device.info"');
  expect(first).toContain('readonly "sensor.readings"');
  expect(first).toContain('readonly "legacy.echo"');
  expect(first).not.toContain("platform.unavailable");
  expect(first).not.toContain("POCKET_PLUGIN_UNAVAILABLE_CAPABILITIES");
  expect(first).toContain("SensorPluginReading");
  expect(first).toContain('from "@pocket/ui/streams"');
  expect(first).toContain("PocketStreamAdapter");
  expect(first).toContain('readonly "unit"?: "c" | "f"');
  expect(first).toContain("type SensorPluginLegacyEchoResult = unknown;");
  expect(first).not.toMatch(/\bany\b/);

  const report = generatePluginTypesReport(input);
  expect(report.includedCapabilities).toEqual(["device.info", "legacy.echo", "sensor.readings"]);
  expect(report.unavailableCapabilities).toEqual(["platform.unavailable"]);
});

test("generator rejects stale registry kind, missing registry, and unsafe names", () => {
  const input = fixture() as Record<string, unknown>;
  const mismatch = structuredClone(input) as Record<string, unknown>;
  const host = mismatch.host as { available: Array<Record<string, unknown>> };
  host.available = host.available.map((entry) => entry.name === "sensor.readings" ? { ...entry, kind: "request" } : entry);
  expect(() => generatePluginTypes(mismatch)).toThrow(PluginTypesError);
  expect(() => generatePluginTypes({ ...input, host: undefined })).toThrow(/actual host registry/);

  const malicious = structuredClone(input) as Record<string, unknown>;
  const plugins = malicious.plugins as Array<Record<string, unknown>>;
  const capabilities = plugins[0]!.capabilities as Array<Record<string, unknown>>;
  capabilities[0] = { ...capabilities[0], name: 'sensor";globalThis.pwned=true;//' };
  expect(() => generatePluginTypes(malicious)).toThrow(/capability name is not safe/);
  expect(() => generatePluginTypes(input, { runtimeDependency: { package: "@pocket/ui/host", version: "9.9.9" } })).toThrow(/does not match/);

  const primitiveReference = structuredClone(input) as Record<string, unknown>;
  const primitivePlugins = primitiveReference.plugins as Array<Record<string, unknown>>;
  primitivePlugins[0]!.types = { Id: { type: "string" } };
  const primitiveCapabilities = primitivePlugins[0]!.capabilities as Array<Record<string, unknown>>;
  primitiveCapabilities[0] = {
    ...primitiveCapabilities[0],
    schema: {
      parameters: { type: "ref", ref: "Id" },
      streamItem: { type: "number" },
    },
  };
  expect(() => generatePluginTypes(primitiveReference)).toThrow(/parameters must be an object/);
});

test("generated client passes an independent positive typecheck and rejects bad parameters", () => {
  const directory = mkdtempSync(join(tmpdir(), "pocket-plugin-types-test-"));
  try {
    const input = fixture() as { plugins: Array<{ types?: Record<string, { properties: Record<string, unknown> }> }> };
    input.plugins[0]!.types!.Reading!.properties.bytes = { type: "array", items: { type: "integer" } };
    writeFileSync(join(directory, "plugin-types.ts"), generatePluginTypes(input, { hostModule: "./host.ts", streamModule: "./streams.ts" }));
    // Check against the actual public transport types, not matching stubs
    // which can pass while the generated client no longer fits the SDK.
    for (const file of ["host.ts", "streams.ts", "responsive.ts"]) {
      copyFileSync(resolve(import.meta.dir, "../../packages/pocket_ui/src", file), join(directory, file));
    }
    writeFileSync(join(directory, "positive.ts"), `
import { createSensorPluginClient } from "./plugin-types.ts";
declare const host: import("./host.ts").HostBridge;
declare const streams: import("./streams.ts").PocketStreamAdapter;
const client = createSensorPluginClient(host, streams);
const info = await client["device.info"]({ serial: "abc" });
info.model.toUpperCase();
for await (const reading of client["sensor.readings"]({ sampleRate: 1 })) {
  reading.value.toFixed(1);
  reading.bytes?.map(byte => byte.toFixed(0));
}
`);
    writeFileSync(join(directory, "negative.ts"), `
import { createSensorPluginClient } from "./plugin-types.ts";
declare const host: import("./host.ts").HostBridge;
const client = createSensorPluginClient(host);
client["device.info"]({ serial: 42 });
client["sensor.readings"]({});
`);
    const common = [process.execPath, resolve(import.meta.dir, "../../.cache/pocketjs/node_modules/typescript/bin/tsc"), "--noEmit", "--strict", "--target", "ESNext", "--module", "ESNext", "--moduleResolution", "bundler", "--skipLibCheck", "--allowImportingTsExtensions"];
    const positive = Bun.spawnSync([...common, join(directory, "positive.ts")]);
    expect(positive.exitCode, new TextDecoder().decode(positive.stdout) + new TextDecoder().decode(positive.stderr)).toBe(0);
    const negative = Bun.spawnSync([...common, join(directory, "negative.ts")]);
    expect(negative.exitCode).not.toBe(0);
    const diagnostics = new TextDecoder().decode(negative.stderr) + new TextDecoder().decode(negative.stdout);
    expect(diagnostics).toMatch(/not assignable|missing/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 30_000);
