/** Original deterministic synthesis. No borrowed recordings or sample packs. */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const rate = 22050;
const output = join(import.meta.dir, "../assets/audio");
mkdirSync(output, { recursive: true });
const tau = Math.PI * 2;
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return (state >>> 0) / 0xffffffff * 2 - 1; };
}
function wav(name: string, seconds: number, sample: (time: number, index: number) => number): void {
  const count = Math.round(seconds * rate);
  const data = new Float32Array(count);
  let peak = 0;
  for (let i = 0; i < count; i++) { data[i] = sample(i / rate, i); peak = Math.max(peak, Math.abs(data[i])); }
  const buffer = Buffer.alloc(44 + count * 2);
  buffer.write("RIFF"); buffer.writeUInt32LE(buffer.length - 8, 4); buffer.write("WAVEfmt ", 8);
  buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(1, 20); buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(rate, 24); buffer.writeUInt32LE(rate * 2, 28); buffer.writeUInt16LE(2, 32); buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36); buffer.writeUInt32LE(count * 2, 40);
  const gain = peak > 0.85 ? 0.85 / peak : 1;
  for (let i = 0; i < count; i++) buffer.writeInt16LE(Math.round(data[i] * gain * 32767), 44 + i * 2);
  writeFileSync(join(output, `${name}.wav`), buffer);
  console.log(`${name}: ${seconds}s, ${count} samples, peak ${peak.toFixed(3)}`);
}
const frequency = (midi: number) => 440 * 2 ** ((midi - 69) / 12);
function music(name: string, chords: number[][], melody: number[], seed: number): void {
  const noise = random(seed);
  let sea = 0;
  wav(name, 24, time => {
    const bar = Math.floor(time / 6) % 4;
    const beat = time % 1.5;
    const note = melody[Math.floor(time / 1.5) % melody.length];
    const f = frequency(note);
    const bell = (Math.sin(tau * f * beat) + 0.25 * Math.sin(tau * f * 2.002 * beat)) * Math.exp(-beat * 3.3) * 0.14;
    const chordTime = time % 6;
    const envelope = Math.min(1, chordTime / 0.8, (6 - chordTime) / 1.2);
    const pad = chords[bar].reduce((sum, key) => sum + Math.sin(tau * frequency(key) * time) + 0.15 * Math.sin(tau * frequency(key) * 2 * time), 0) * envelope * 0.035;
    sea = sea * 0.985 + noise() * 0.015;
    const fade = Math.min(1, time / 0.8, (24 - time) / 0.8);
    return (bell + pad + sea * 0.16) * fade;
  });
}
music("music_storm", [[48,55,63],[44,51,60],[51,58,67],[46,53,62]], [72,67,75,74,72,68,67,63,67,70,75,79,77,74,70,67], 0x5021);
music("music_letter", [[48,55,63],[53,60,68],[44,51,60],[55,62,67]], [79,75,72,67,77,72,68,65,75,72,68,63,74,71,67,62], 0x7114);
music("music_dawn", [[48,55,64],[53,60,69],[55,62,71],[48,55,64]], [72,76,79,84,81,79,76,72,74,79,83,86,84,79,76,72], 0x2041);
{
  const noise = random(0x8123); let wind = 0;
  wav("roof_gust", 8, time => { wind = wind * 0.94 + noise() * 0.06; return wind * (0.2 + 0.16 * Math.sin(tau * time / 8)) * Math.sin(Math.PI * time / 8); });
}
wav("station_bell", 2.8, time => (Math.sin(tau * 660 * time) * 0.35 + Math.sin(tau * 1323 * time) * 0.13 + Math.sin(tau * 1801 * time) * 0.08) * Math.exp(-2.8 * time) * Math.min(1, time * 150));
wav("relay_click", 0.18, time => Math.sin(tau * (1500 - 3000 * time) * time) * Math.exp(-45 * time) * 0.4);
function textBlip(name: string, pitch: number, shape: "sine" | "triangle" | "round"): void {
  const duration = 0.045;
  wav(name, duration, time => {
    const fundamental = Math.sin(tau * pitch * time);
    const triangle = 2 / Math.PI * Math.asin(fundamental);
    const tone = shape === "triangle" ? triangle
      : shape === "round" ? fundamental + 0.16 * Math.sin(tau * pitch * 2 * time)
        : fundamental + 0.12 * Math.sin(tau * pitch * 2 * time);
    const envelope = Math.min(1, time / 0.004, (duration - time) / 0.012) * Math.exp(-time * 12);
    return tone * envelope * 0.14;
  });
}
textBlip("text_narrator", 523.25, "sine");
textBlip("text_mira", 659.25, "triangle");
textBlip("text_ren", 440, "round");
{
  const noise = random(0x3145);
  wav("relay_break", 0.8, time => noise() * Math.exp(-8 * time) * 0.3 + Math.sin(tau * 72 * time) * Math.exp(-12 * time) * 0.2);
}
{
  const noise = random(0x1175); let rumble = 0;
  wav("train_depart", 7, time => { rumble = rumble * 0.91 + noise() * 0.09; return (rumble * (0.3 + 0.2 * Math.sin(tau * (2 + time) * time) ** 2) + Math.sin(tau * 440 * time) * Math.exp(-((time - 1.5) ** 2) / 0.7) * 0.07) * Math.min(1, time, (7 - time) / 2); });
}
