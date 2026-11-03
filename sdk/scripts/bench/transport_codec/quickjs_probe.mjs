#!/usr/bin/env node
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const probe = process.argv[2];
if (!probe) {
  throw new Error('usage: node quickjs_probe.mjs <pocket_probe> [iterations=6000] [samples=7] [warmup=2000]');
}
const iterations = Number(process.argv[3] ?? 6000);
const samples = Number(process.argv[4] ?? 7);
const warmup = Number(process.argv[5] ?? 2000);
const bundle = fs.readFileSync(path.join(here, 'bench.bundle.js'), 'utf8');
const child = spawn(probe, [], { stdio: ['pipe', 'pipe', 'inherit'], timeout: 30000 });
let output = '';
child.stdout.setEncoding('utf8');
child.stdout.on('data', (chunk) => { output += chunk; });
child.on('close', (code) => {
  const responses = output.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  if (code !== 0 || responses.some((response) => response.ok === false)) {
    process.stderr.write(JSON.stringify({ code, responses }, null, 2) + '\n');
    process.exitCode = 1;
    return;
  }
  const frames = responses.filter((response) => response.frame).map((response) => response.frame);
  const results = frames.flatMap((frame) => frame.events ?? []).filter((event) => event.name === 'proto.bench').map((event) => event.payload);
  process.stdout.write(JSON.stringify({ probe, iterations, samples, warmup, results }, null, 2) + '\n');
});
const commands = [
  { op: 'create', width: 390, height: 844 },
  { op: 'eval', source: bundle },
  { op: 'frame', deltaMs: 16 },
  ...['request', 'response', 'pointer'].flatMap((name) => [
    { op: 'eval', source: `globalThis.__pocketProtoBenchRun(${JSON.stringify(name)}, ${iterations}, ${samples}, ${warmup});` },
    { op: 'frame', deltaMs: 16 },
  ]),
  { op: 'quit' },
];
for (const command of commands) child.stdin.write(JSON.stringify(command) + '\n');
child.stdin.end();
