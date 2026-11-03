import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { buildGuest } from "../build_guest.ts";

const fixtureRootInput = process.argv[2] ?? process.env.POCKET_RECORDING_WORKER_FIXTURE_DIR;
if (!fixtureRootInput) {
  throw new Error(
    "Pass an output directory or set POCKET_RECORDING_WORKER_FIXTURE_DIR",
  );
}

const fixtureRoot = resolve(fixtureRootInput);
const assetRoot = join(fixtureRoot, "assets");
const projectRoot = mkdtempSync(join(tmpdir(), "pocket-worker-recording-fixture-"));

const declaration = {
  entry: "worker.ts",
  nodes: [{ name: "server", kind: "http" }],
  channels: [
    {
      name: "results",
      kind: "ring",
      direction: "worker-to-ui",
      recordBytes: 1024,
      capacity: 8,
    },
    {
      name: "input",
      kind: "ring",
      direction: "ui-to-worker",
      recordBytes: 1024,
      capacity: 8,
    },
  ],
};

try {
  mkdirSync(assetRoot, { recursive: true });
  writeFileSync(
    join(projectRoot, "pocket.json"),
    JSON.stringify({ app: { entry: "app.tsx" }, domains: { worker: declaration } }),
  );
  writeFileSync(
    join(projectRoot, "manifest.json"),
    JSON.stringify({ capabilities: { requires: ["net.http"] } }),
  );
  writeFileSync(
    join(projectRoot, "app.tsx"),
    "export default function App(){ return <text value='Worker recording fixture'/>; }\n",
  );
  writeFileSync(
    join(projectRoot, "worker.ts"),
    [
      'import { FactKind, io, utf8 } from "@pocketjs/framework/io";',
      'const output = io.channel("results");',
      'const input = io.channel("input");',
      "void (async () => {",
      "  for await (const bytes of input.observe()) {",
      '    const url = Array.from(bytes, value => String.fromCharCode(value)).join("");',
      '    const response = io.http("server").open({ url, timeoutMs: 5000 });',
      "    const request = response.submit();",
      "    for await (const fact of response.observe()) {",
      "      if (fact.kind === FactKind.data) {",
      '        const text = Array.from(fact.data, value => String.fromCharCode(value)).join("");',
      '        output.publish(utf8("body:" + text));',
      "      }",
      "      if (fact.kind === FactKind.error) {",
      '        const text = Array.from(fact.data, value => String.fromCharCode(value)).join("");',
      '        output.publish(utf8("error:" + text));',
      "      }",
      "      if (fact.kind === FactKind.end) {",
      '        output.publish(utf8("end:" + fact.status));',
      "        break;",
      "      }",
      "    }",
      "    break;",
      "  }",
      "})();",
      "",
    ].join("\n"),
  );

  const built = await buildGuest({
    projectRoot,
    outDir: join(projectRoot, "out"),
    copyAssetsTo: assetRoot,
  });
  if (!built.worker || !built.worker.bytecode || !built.worker.metadata) {
    throw new Error("build_guest did not produce a Worker QJBC fixture");
  }

  console.log(`Worker recording fixture written to ${fixtureRoot}`);
} finally {
  rmSync(projectRoot, { recursive: true, force: true });
}
