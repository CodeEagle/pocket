/**
 * Build the CodeView guest for the Flutter end-to-end test (pocket_view_code_view_ffi_test.dart).
 * Usage: bun packages/pocket_ui/test/code_view_flutter_fixture.ts <outdir>
 * Writes app.qjbc, app.pak, app.bytecode.json, guest-manifest.json into <outdir>.
 */
import { copyFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { buildGuestProject } from "./code_view_harness.ts";
import { codeViewApp } from "./code_view_app.ts";

const outDir = resolve(process.argv[2] ?? "");
if (!process.argv[2]) throw new Error("usage: code_view_flutter_fixture.ts <outdir>");
const g = buildGuestProject({ "app.tsx": codeViewApp({}) }, ["code_corpus.ts"]);
try {
  mkdirSync(outDir, { recursive: true });
  for (const f of ["app.qjbc", "app.pak", "app.bytecode.json", "guest-manifest.json"]) copyFileSync(join(g.out, f), join(outDir, f));
  console.log("code_view fixture written to " + outDir);
} finally { g.cleanup(); }
