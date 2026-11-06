import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { BYTECODE_ABI, UPSTREAM_REVISION, validateToolsPackage, resolvePrebuiltTools, nativeBindingEnvironment } from '../prebuilt_tools.mjs';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'pocket-prebuilt-integrity-'));
  const manifest: any = { schemaVersion: 1, sdkVersion: '0.1.1', upstreamRevision: UPSTREAM_REVISION,
    bytecodeAbi: BYTECODE_ABI, platform: process.platform, arch: process.arch, files: {} };
  const suffix = process.platform === 'win32' ? '.exe' : '';
  for (const file of [`bin/pocketjs_bytecode${suffix}`, `bin/pocket_probe${suffix}`, 'compiler/tools/build.ts', 'compiler/framework/compiler/jsx-plugin.ts']) {
    const bytes = Buffer.from(file);
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), bytes);
    manifest.files[file] = { size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
  }
  const save = () => writeFileSync(join(root, 'manifest.json'), JSON.stringify(manifest));
  save();
  return { root, manifest, save };
}

test('prebuilt admission rejects wrong platform, ABI, missing payload and tampering', () => {
  const f = fixture();
  try {
    expect(validateToolsPackage(f.root).compiler).toBe(join(f.root, 'compiler'));
    f.manifest.platform = 'another-platform'; f.save();
    expect(() => validateToolsPackage(f.root)).toThrow(/平台不匹配/);
    f.manifest.platform = process.platform;
    f.manifest.bytecodeAbi = 'different-quickjs'; f.save();
    expect(() => validateToolsPackage(f.root)).toThrow(/ABI 不匹配/);
    f.manifest.bytecodeAbi = BYTECODE_ABI; f.save();
    writeFileSync(join(f.root, 'compiler/tools/build.ts'), 'changed');
    expect(() => validateToolsPackage(f.root)).toThrow(/完整性校验失败/);
    delete f.manifest.files['compiler/tools/build.ts']; f.save();
    expect(() => validateToolsPackage(f.root)).toThrow(/清单缺少/);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('missing platform package fails without requesting a source compiler', () => {
  const root = mkdtempSync(join(tmpdir(), 'pocket-no-platform-'));
  try {
    writeFileSync(join(root, 'package.json'), '{}');
    expect(() => resolvePrebuiltTools(root, {})).toThrow(/不会自动安装 Rust 或回退到源码编译/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});


test('native bindings use node-gyp-build scoped environment without mutating caller state', () => {
  const root = join(tmpdir(), 'pocket-native-platform');
  expect(nativeBindingEnvironment({ root, manifest: { noble: { included: true }, hci: { included: true } } })).toEqual({
    '@ABANDONWARE/NOBLE_PREBUILD': join(root, 'noble'),
  });
  expect(nativeBindingEnvironment({ root, manifest: { noble: { included: false } } })).toEqual({});
});
