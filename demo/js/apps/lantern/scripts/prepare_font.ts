import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const project = resolve(import.meta.dir, "..");
const revision = "f8d157532fbfaeda587e826d4cd5b21a49186f7c";
const expected = "2a2eae2628df83556c54018c41e20fa532c1b862c5256ae8b3f23feb918d12ca";
const url = `https://raw.githubusercontent.com/notofonts/noto-cjk/${revision}/Serif/OTF/SimplifiedChinese/NotoSerifCJKsc-Regular.otf`;
const cache = join(project, ".pocket-build/font-source");
mkdirSync(cache, { recursive: true }); mkdirSync(join(project, "fonts"), { recursive: true });
const source = join(cache, "NotoSerifCJKsc-Regular.otf");
if (!existsSync(source)) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Font download failed: ${response.status}`);
  writeFileSync(source, new Uint8Array(await response.arrayBuffer()));
}
if (createHash("sha256").update(readFileSync(source)).digest("hex") !== expected) throw new Error("Font source checksum mismatch");
const text = ["story.json", "novel.assets.json", "novel.locales.json", "app.tsx", "../../../../sdk/packages/pocket_vn/src/view.tsx", "../../../../sdk/packages/pocket_vn/src/localization.ts"].map(name => readFileSync(resolve(project, name), "utf8")).join("\n");
const characters = [...new Set(text)].filter(character => character.codePointAt(0)! >= 32).sort().join("");
const characterFile = join(cache, "characters.txt");
writeFileSync(characterFile, characters);
const result = spawnSync("uv", ["tool", "run", "--from", "fonttools==4.60.1", "pyftsubset", source, `--text-file=${characterFile}`, `--output-file=${join(project, "fonts/lantern.otf")}`, "--layout-features=*", "--name-IDs=*", "--name-languages=*", "--name-legacy"], { stdio: "inherit" });
if (result.status !== 0) throw new Error("Pinned font subset failed; install uv to reproduce");
const license = await fetch(`https://raw.githubusercontent.com/notofonts/noto-cjk/${revision}/Serif/LICENSE`);
if (!license.ok) throw new Error(`Font license download failed: ${license.status}`);
writeFileSync(join(project, "fonts/LICENSE-NotoSerifCJK.txt"), await license.text());
console.log(`Prepared ${characters.length} characters from pinned Noto Serif CJK SC, source sha256 ${expected}`);
