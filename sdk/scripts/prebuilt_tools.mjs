import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { delimiter, dirname, isAbsolute, join, relative, resolve } from 'node:path';

export const SDK_VERSION = '0.1.8';
export const UPSTREAM_REVISION = '99924de47c62fa36f526a8791055d91cbbdb3836';
export const BYTECODE_ABI = 'quickjs-bytecode-v1:5ab2246bcbd64b9d66e396043be05c2f77e7a6ab78e3125c56f8a1f62019a021';
export const platformPackageName = (platform = process.platform, arch = process.arch) => `@pocket/tools-${platform}-${arch}`;

export function validateToolsPackage(directory, platform = process.platform, arch = process.arch) {
  const root = resolve(directory);
  const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
  if (manifest.schemaVersion !== 1 || manifest.sdkVersion !== SDK_VERSION || manifest.upstreamRevision !== UPSTREAM_REVISION || manifest.bytecodeAbi !== BYTECODE_ABI) {
    throw new Error(`Pocket 预编译工具版本/ABI 不匹配：${root}`);
  }
  if (manifest.platform !== platform || manifest.arch !== arch) throw new Error(`Pocket 工具平台不匹配：需要 ${platform}/${arch}，实际 ${manifest.platform}/${manifest.arch}`);
  const suffix = platform === 'win32' ? '.exe' : '';
  const required = [
    `bin/pocketjs_bytecode${suffix}`,
    `bin/pocket_probe${suffix}`,
    'compiler/tools/build.ts',
    'compiler/framework/compiler/jsx-plugin.ts',
    'compiler/framework/compiler/subpaths.ts',
    'compiler/framework/src/inline-fonts.ts',
    'compiler/tools/inline-text-slots.ts',
  ];
  for (const name of required) if (!manifest.files?.[name]) throw new Error(`Pocket 工具清单缺少 ${name}`);
  for (const [name, expected] of Object.entries(manifest.files)) {
    const path = resolve(root, name);
    const rel = relative(root, path);
    if (!name || isAbsolute(name) || rel.startsWith('..') || isAbsolute(rel)) throw new Error(`Pocket 工具清单含非法路径：${name}`);
    if (!statSync(path).isFile()) throw new Error(`Pocket 工具文件无效：${name}`);
    const bytes = readFileSync(path);
    if (bytes.length !== expected.size || createHash('sha256').update(bytes).digest('hex') !== expected.sha256) {
      throw new Error(`Pocket 工具完整性校验失败：${name}`);
    }
  }
  return { root, manifest, compiler: join(root, 'compiler'), bytecode: join(root, `bin/pocketjs_bytecode${suffix}`), probe: join(root, `bin/pocket_probe${suffix}`) };
}

export function resolvePrebuiltTools(sdkRoot, env = process.env) {
  let directory = env.POCKET_TOOLS_PACKAGE?.trim();
  const name = platformPackageName();
  if (!directory) {
    try { directory = dirname(createRequire(join(resolve(sdkRoot), 'package.json')).resolve(`${name}/package.json`)); }
    catch { throw Object.assign(new Error(`尚未安装 ${name}@${SDK_VERSION}。请运行 npm run setup，或安装当前系统对应的 Pocket 预编译平台包。不会自动安装 Rust 或回退到源码编译。`), { code: 'POCKET_TOOLS_MISSING' }); }
  }
  return validateToolsPackage(directory);
}

export function resolveManagedBun(sdkRoot, env = process.env) {
  const configured = env.POCKET_BUN || env.POCKET_EDITOR_BUN;
  if (configured) {
    if (!existsSync(configured)) throw new Error(`Bun 路径无效：${configured}`);
    return resolve(configured);
  }
  const require = createRequire(join(resolve(sdkRoot), 'package.json'));
  // Prefer the payload directly: this also works with npm --ignore-scripts.
  const os = process.platform === 'win32' ? 'windows' : process.platform;
  const cpu = process.arch === 'arm64' ? 'aarch64' : process.arch;
  const names = [`@oven/bun-${os}-${cpu}`, `@oven/bun-${os}-${cpu}-baseline`];
  for (const name of names) {
    try {
      const root = dirname(require.resolve(`${name}/package.json`));
      for (const file of ['bin/bun', 'bin/bun.exe']) if (existsSync(join(root, file))) return join(root, file);
    } catch {}
  }
  try {
    const root = dirname(require.resolve('bun/package.json'));
    if (existsSync(join(root, 'bin/bun.exe'))) return join(root, 'bin/bun.exe');
  } catch {}
  throw new Error('缺少 npm 管理的 Bun 运行时；请执行 npm run setup。无需全局安装 Bun。');
}

export function nativeBindingEnvironment(tools) {
  const result = {};
  if (tools.manifest.noble?.included) result['@ABANDONWARE/NOBLE_PREBUILD'] = join(tools.root, 'noble');
  return result;
}

export function prebuiltEnvironment(sdkRoot, env = process.env) {
  const tools = resolvePrebuiltTools(sdkRoot, env);
  const bun = resolveManagedBun(sdkRoot, env);
  return { ...env, ...nativeBindingEnvironment(tools), POCKET_TOOLS_PACKAGE: tools.root, POCKET_UPSTREAM_ROOT: tools.compiler,
    POCKET_COMPILER_PATH: join(tools.compiler, 'tools/build.ts'), POCKET_BYTECODE_BIN: tools.bytecode,
    POCKET_NATIVE_PROBE: env.POCKET_NATIVE_PROBE || tools.probe, POCKET_BUN: bun, POCKET_EDITOR_BUN: bun,
    PATH: `${dirname(bun)}${delimiter}${env.PATH || ''}` };
}
