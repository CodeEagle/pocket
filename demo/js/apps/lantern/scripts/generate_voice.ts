import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { spawnSync } from "node:child_process";

// Build-time speech only. The game ships ordinary WAVs, with no TTS runtime.
const project = resolve(import.meta.dir, "..");
const cache = resolve(project, "../../../../sdk/.cache/lantern-voice-tools");
const version = "1.52.0";
const sha256 = "bb4338102ff3b49a81423da8a1a158b420124b055b60fa76cfb4b18677130a23";
const archive = join(cache, `espeak-ng-${version}.tar.gz`);
const executable = join(cache, "install/bin/espeak-ng");
const run = (command: string, args: string[], input?: string) => {
  const result = spawnSync(command, args, { input, stdio: input === undefined ? "inherit" : ["pipe", "inherit", "inherit"], timeout: 300_000 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited ${result.status}`);
};
mkdirSync(cache, { recursive: true });
if (!existsSync(executable)) {
  if (!existsSync(archive)) {
    const response = await fetch(`https://github.com/espeak-ng/espeak-ng/archive/refs/tags/${version}.tar.gz`);
    if (!response.ok) throw new Error(`eSpeak download failed: ${response.status}`);
    writeFileSync(archive, new Uint8Array(await response.arrayBuffer()));
  }
  if (createHash("sha256").update(readFileSync(archive)).digest("hex") !== sha256) throw new Error("eSpeak source checksum mismatch");
  run("tar", ["-xzf", archive, "-C", cache]);
  run("cmake", ["-S", join(cache, `espeak-ng-${version}`), "-B", join(cache, "build"), "-DCMAKE_BUILD_TYPE=Release", "-DUSE_LIBPCAUDIO=OFF", "-DUSE_LIBSONIC=OFF", "-DUSE_MBROLA=OFF", "-DUSE_ASYNC=OFF", `-DCMAKE_INSTALL_PREFIX=${join(cache, "install")}`]);
  run("cmake", ["--build", join(cache, "build"), "--parallel", "4"]);
  run("cmake", ["--install", join(cache, "build")]);
}
const story = JSON.parse(readFileSync(join(project, "story.json"), "utf8"));
const locales = JSON.parse(readFileSync(join(project, "novel.locales.json"), "utf8"));
const line = Object.values(story.script).flat().find((value: any) => value.id === "arrival_02") as { text: string };
mkdirSync(join(project, "assets/audio"), { recursive: true });
for (const [suffix, voice, text] of [["", "cmn", line.text], ["_en", "en-us", locales.catalogs.en.lines.arrival_02]]) {
  run(executable, ["-v", voice, "-s", "155", "-p", "48", "--stdin", "-w", join(project, `assets/audio/voice_mira_arrival_02${suffix}.wav`)], text);
}
console.log(`Generated original arrival_02 dialogue using pinned eSpeak NG ${version}; source SHA256 ${sha256}`);
