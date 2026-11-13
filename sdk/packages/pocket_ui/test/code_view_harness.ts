/**
 * Test harness: build a guest with buildGuest and drive it on the real native
 * probe (persistent process, one reply line per command).
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

export type DrawOp = { type?: string; text?: string; color?: number; x?: number; y?: number; w?: number; h?: number; [k: string]: any };
export type FrameEvent = { name?: string; payload?: any };
export type Frame = { ops?: DrawOp[]; events?: FrameEvent[] };

const sdk = resolve(import.meta.dir, "../../..");

export function probePath(): string {
  const p = process.env.POCKET_NATIVE_PROBE ?? [
    "native/target/aarch64-apple-darwin/release/pocket_probe",
    "native/target/release/pocket_probe", "native/target/debug/pocket_probe",
  ].map(path => join(sdk, path)).find(existsSync);
  if (!p) throw new Error("pocket_probe not found; set POCKET_NATIVE_PROBE");
  return p;
}

export interface BuiltGuest { dir: string; out: string; cleanup(): void }

/** Build `files` (must include app.tsx) into a project; extra files are copied from `copy` (names in this test dir). */
export function buildGuestProject(files: Record<string, string>, copy: string[] = [], manifest: object = { capabilities: { requires: [], optional: ["clipboard.readText", "clipboard.writeText"] } }): BuiltGuest {
  const dir = mkdtempSync(join(tmpdir(), "pocket-code-view-"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "code-view-fixture", type: "module" }));
  writeFileSync(join(dir, "pocket.json"), JSON.stringify({ pocket: 2, id: "dev.pocket.code-view", version: "0.1.0", app: { entry: "app.tsx", output: "app", framework: "solid" } }));
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest));
  for (const f of copy) writeFileSync(join(dir, f), readFileSync(join(import.meta.dir, f)));
  for (const [name, text] of Object.entries(files)) { mkdirSync(dirname(join(dir, name)), { recursive: true }); writeFileSync(join(dir, name), text); }
  const out = join(dir, "out");
  const build = spawnSync("bun", [join(sdk, "scripts/build_guest.ts"), "--project-root=" + dir, "--outdir=" + out], { encoding: "utf8", timeout: 180_000 });
  if (build.status !== 0) { rmSync(dir, { recursive: true, force: true }); throw new Error("buildGuest failed\n" + build.stdout + build.stderr); }
  return { dir, out, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

export class ProbeSession {
  private child: ChildProcessWithoutNullStreams;
  private buf = "";
  private waiters: ((line: string) => void)[] = [];
  private lines: string[] = [];
  /** Every frame returned so far (since last `clearFrames`). */
  frames: Frame[] = [];
  last: Frame = {};
  stderr = "";
  constructor(private built: BuiltGuest, width = 480, height = 640) {
    this.child = spawn(probePath(), [], { stdio: ["pipe", "pipe", "pipe"] });
    this.child.stdout.setEncoding("utf8");
    this.child.stderr.on("data", d => { this.stderr += d; });
    this.child.stdout.on("data", (d: string) => {
      this.buf += d;
      let i: number;
      while ((i = this.buf.indexOf("\n")) >= 0) {
        const line = this.buf.slice(0, i); this.buf = this.buf.slice(i + 1);
        const w = this.waiters.shift();
        if (w) w(line); else this.lines.push(line);
      }
    });
    this.pending = this.boot(width, height);
  }
  private pending: Promise<void>;
  private async boot(width: number, height: number) {
    await this.cmd({ op: "create", width, height });
    await this.cmd({ op: "loadBytecode", bytecodePath: join(this.built.out, "app.qjbc"), pakPath: join(this.built.out, "app.pak") });
    await this.frame(); await this.frame();
  }
  ready(): Promise<void> { return this.pending; }
  private next(): Promise<string> {
    const l = this.lines.shift();
    return l !== undefined ? Promise.resolve(l) : new Promise(r => this.waiters.push(r));
  }
  async cmd(c: object): Promise<any> {
    this.child.stdin.write(JSON.stringify(c) + "\n");
    const rep = JSON.parse(await this.next());
    if (rep.ok === false) throw new Error("probe error: " + JSON.stringify(rep));
    if (rep.frame) { this.last = rep.frame; this.frames.push(rep.frame); }
    return rep;
  }
  async frame(deltaMs = 16): Promise<Frame> { await this.cmd({ op: "frame", deltaMs }); return this.last; }
  /** Send an event, then run a frame so the guest handles it. */
  async send(name: string, payload: any, frames = 1): Promise<Frame> {
    await this.cmd({ op: "send", message: { type: "event", name, payload } });
    for (let i = 0; i < frames; i++) await this.frame();
    return this.last;
  }
  /** Raw text events (one input.text batch per frame). */
  text(events: any[]): Promise<Frame> { return this.send("input.text", events); }
  pointer(phase: "down" | "move" | "up", x: number, y: number): Promise<Frame> { return this.send("input.pointer", { phase, id: 0, x, y }); }
  events(name: string): any[] { return this.frames.flatMap(f => (f.events ?? []).filter(e => e.name === name).map(e => e.payload)); }
  clearFrames() { this.frames = []; }
  async close() {
    try { this.child.stdin.write(JSON.stringify({ op: "quit" }) + "\n"); this.child.stdin.end(); } catch {}
    await new Promise(r => { this.child.once("exit", r); setTimeout(r, 3000); });
    this.child.kill();
  }
}

export function texts(f: Frame): string[] { return (f.ops ?? []).filter(o => o.type === "text").map(o => o.text as string); }
