import { readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";

// Bun's module mocks are process-wide and survive test-file boundaries.
// Give each file its own realm while preserving all tests and exit failures.
const inputs = process.argv.slice(2);
if (!inputs.length) throw new Error("Usage: bun scripts/test_js.ts <test file or directory>...");
const files = new Set<string>();
function collect(input: string): void {
  const path = resolve(input);
  if (statSync(path).isDirectory()) {
    for (const entry of readdirSync(path).sort()) {
      if (entry.startsWith(".") || entry === "node_modules") continue;
      collect(`${path}/${entry}`);
    }
  } else if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(path)) files.add(path);
}
inputs.forEach(collect);
if (!files.size) throw new Error("No test files selected");
const failures: string[] = [];
for (const file of [...files].sort()) {
  const child = Bun.spawn([process.execPath, "test", "--timeout", "60000", file], {
    stdin: "inherit", stdout: "inherit", stderr: "inherit", env: process.env,
  });
  if (await child.exited !== 0) failures.push(file);
}
console.log(`Isolated JS suites: ${files.size - failures.length}/${files.size} passed`);
for (const file of failures) console.error(`FAILED: ${file}`);
process.exitCode = failures.length ? 1 : 0;
