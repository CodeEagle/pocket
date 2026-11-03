import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildGuest } from "../build_guest.ts";

const root = join(import.meta.dir, "../..");
const timeout = 300_000;

test("native worker runs QJBC, HTTP, bounded channels and cancellation", async () => {
  const project = mkdtempSync(join(tmpdir(), "pocket-worker-native-"));
  let serverRequests = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      serverRequests += 1;
      const url = new URL(request.url);
      if (url.pathname === "/slow") await Bun.sleep(800);
      return new Response(url.pathname === "/ok" ? "local-http-body" : "late-body");
    },
  });
  const origin = "http://127.0.0.1:" + server.port;
  const declaration = {
    entry: "worker.ts",
    nodes: [{ name: "server", kind: "http" }],
    channels: [
      {
        name: "results",
        kind: "ring",
        direction: "worker-to-ui",
        recordBytes: 128,
        capacity: 2,
      },
      {
        name: "input",
        kind: "ring",
        direction: "ui-to-worker",
        recordBytes: 128,
        capacity: 2,
      },
    ],
  };
  try {
    writeFileSync(
      join(project, "pocket.json"),
      JSON.stringify({
        app: { entry: "app.tsx" },
        domains: { worker: declaration },
      }),
    );
    writeFileSync(
      join(project, "manifest.json"),
      JSON.stringify({ capabilities: { requires: ["net.http"] } }),
    );
    writeFileSync(
      join(project, "app.tsx"),
      "export default function App(){ return <text value='native worker'/>; }\n",
    );
    const workerSource = [
      'import { FactKind, io, utf8 } from "@pocketjs/framework/io";',
      'const output = io.channel("results");',
      'const input = io.channel("input");',
      "const response = io.http(\"server\").open({ url: " +
        JSON.stringify(origin + "/ok") +
        ", timeoutMs: 5000 });",
      "const request = response.submit();",
      "void (async () => {",
      "  for await (const fact of response.observe()) {",
      "    if (fact.kind === FactKind.data) {",
      '      const text = Array.from(fact.data, value => String.fromCharCode(value)).join("");',
      '      output.publish(utf8("http:" + text));',
      "    }",
      "    if (fact.kind === FactKind.error) {",
      '      const text = Array.from(fact.data, value => String.fromCharCode(value)).join("");',
      '      output.publish(utf8("error:" + text));',
      "    }",
      "    if (fact.kind === FactKind.end) {",
      '      output.publish(utf8("end:" + fact.status));',
      "      break;",
      "    }",
      "  }",
      "})();",
      "void (async () => {",
      "  for await (const bytes of input.observe()) {",
      "    if (bytes[0] === 9) {",
      "      response.cancel(request);",
      "    } else {",
      "      let sum = 0;",
      "      for (const value of bytes) sum += value;",
      '      output.publish(utf8("sum:" + sum));',
      "    }",
      "  }",
      "})();",
      "",
    ].join("\n");
    const sourcePath = join(project, "worker.ts");
    writeFileSync(sourcePath, workerSource);

    const built = await buildGuest({ projectRoot: project, outDir: join(project, "out") });
    const workerMetadata = JSON.parse(
      await Bun.file(built.worker!.metadata).text(),
    ) as Record<string, unknown>;
    expect(workerMetadata.entryFormat).toBe("quickjs-bytecode");
    const runProbe = async (bytecode: string, cancel: boolean) => {
      const native = Bun.spawn(
        [
          "cargo",
          "run",
          "--locked",
          "--manifest-path",
          join(root, "native/Cargo.toml"),
          "--bin",
          "pocket_worker_probe",
          "--",
          "--bytecode",
          bytecode,
          "--declaration",
          JSON.stringify(declaration),
          "--origin",
          origin,
          ...(cancel ? ["--cancel"] : []),
        ],
        { cwd: root, stdout: "pipe", stderr: "pipe" },
      );
      const [status, stdout, stderr] = await Promise.all([
        native.exited,
        new Response(native.stdout).text(),
        new Response(native.stderr).text(),
      ]);
      if (status !== 0) {
        throw new Error(
          "native worker probe failed (serverRequests=" +
            serverRequests +
            "):\n" +
            stdout +
            "\n" +
            stderr,
        );
      }
      const resultLine = stdout
        .split("\n")
        .find((line) => line.startsWith("WORKER_PROBE_RESULT:"));
      if (!resultLine) throw new Error("probe result missing:\n" + stdout);
      return JSON.parse(resultLine.slice("WORKER_PROBE_RESULT:".length)) as string[];
    };

    const success = await runProbe(built.worker!.bytecode, false);
    expect(success).toContain("sum:6");
    expect(success).toContain("http:local-http-body");
    expect(success).toContain("end:0");

    writeFileSync(
      sourcePath,
      workerSource.replace(origin + "/ok", origin + "/slow"),
    );
    const cancelBuild = await buildGuest({
      projectRoot: project,
      outDir: join(project, "cancel-out"),
    });
    const native = Bun.spawn(
      [
        "cargo",
        "run",
        "--locked",
        "--manifest-path",
        join(root, "native/Cargo.toml"),
        "--bin",
        "pocket_worker_probe",
        "--",
        "--bytecode",
        cancelBuild.worker!.bytecode,
        "--declaration",
        JSON.stringify(declaration),
        "--origin",
        origin,
        "--cancel",
      ],
      { cwd: root, stdout: "pipe", stderr: "pipe" },
    );
    const [status, stdout, stderr] = await Promise.all([
      native.exited,
      new Response(native.stdout).text(),
      new Response(native.stderr).text(),
    ]);
    if (status !== 0) {
      throw new Error("native cancellation probe failed:\n" + stdout + "\n" + stderr);
    }
    const line = stdout
      .split("\n")
      .find((value) => value.startsWith("WORKER_PROBE_RESULT:"));
    expect(line).toBeDefined();
    const cancelled = JSON.parse(
      line!.slice("WORKER_PROBE_RESULT:".length),
    ) as string[];
    expect(cancelled).toContain("sum:7");
    expect(cancelled).toContain("end:-2");
    expect(cancelled).not.toContain("http:late-body");
    expect(serverRequests).toBeGreaterThanOrEqual(2);
  } finally {
    server.stop(true);
    rmSync(project, { recursive: true, force: true });
  }
}, timeout);
