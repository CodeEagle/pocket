#!/usr/bin/env node
// npm entry points only orchestrate the existing pinned compiler and runtime.
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { platformPackageName, prebuiltEnvironment, resolvePrebuiltTools, SDK_VERSION } from './prebuilt_tools.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const action = process.argv[2];
const args = process.argv.slice(3);
const actions = ['setup', 'bootstrap', 'build:guest', 'build:probe', 'doctor', 'run', 'setup:source', 'bootstrap:source', 'build:probe:source'];

function run(command, argv, cwd = root, env = process.env) {
  const child = spawnSync(command, argv, { cwd, env, stdio: 'inherit' });
  if (child.error) throw new Error(`${command}: ${child.error.message}`);
  if (child.status !== 0) throw new Error(`${command} exited with ${child.status ?? child.signal}`);
}

function check(command, argv, label) {
  const child = spawnSync(command, argv, { encoding: 'utf8' });
  if (child.error || child.status !== 0) throw new Error(`缺少 ${label}；请安装后重新运行 npm run setup (${command})`);
  console.log(`[toolchain] ${label}: ${`${child.stdout ?? ''}${child.stderr ?? ''}`.trim().split(/\r?\n/)[0]}`);
}

function python() {
  const candidates = process.env.POCKET_PYTHON
    ? [process.env.POCKET_PYTHON]
    : process.platform === 'win32' ? ['python', 'python3'] : ['python3', 'python'];
  for (const command of candidates) {
    const result = spawnSync(command, ['--version'], { encoding: 'utf8' });
    if (result.status === 0 && /^Python 3\./.test(`${result.stdout ?? ''}${result.stderr ?? ''}`.trim())) return command;
  }
  throw new Error('缺少 Python 3；安装后把 python/python3 加入 PATH，或设置 POCKET_PYTHON 为可执行文件路径');
}

function checkNodeVersion() {
  const version = process.versions.node.split('.').map(Number);
  const minimum = [22, 22, 2];
  const comparison = version.reduce((result, part, index) => result || Math.sign(part - minimum[index]), 0);
  if (comparison < 0) throw new Error('需要 Node.js >= 22.22.2（建议 Node.js 24 LTS）；固定编译器依赖不支持 Node.js 20');
}

function prerequisites(native) {
  checkNodeVersion();
  const py = python();
  check('bun', ['--version'], 'Bun');
  check(py, ['--version'], 'Python 3');
  check('patch', ['--version'], 'GNU/BSD patch');
  if (native) check('cargo', ['--version'], 'Rust/Cargo >= 1.93（另需本机 C/C++ 工具链）');
  return { ...process.env, POCKET_PYTHON: py };
}

function installDependencies(env) {
  // npm run supplies its CLI path; invoking it with Node also works on Windows
  // without shell quoting or attempting to execute npm.cmd as a native binary.
  if (!process.env.npm_execpath) throw new Error('请通过 npm run setup 或 npm run bootstrap 调用');
  // npm traverses Bun's isolated package store as extraneous dependencies and
  // can fail on workspace protocols inside those packages. Recreate only this
  // generated dependency directory when switching an existing Bun checkout.
  const modules = join(root, 'node_modules');
  if (existsSync(join(modules, '.bun')) && !lstatSync(modules).isSymbolicLink()) {
    console.log('[toolchain] 清理旧 Bun node_modules，改由 npm 安装 SDK 依赖');
    rmSync(modules, { recursive: true, force: true });
  }
  run(process.execPath, [process.env.npm_execpath, existsSync(join(root, 'package-lock.json')) ? 'ci' : 'install', '--no-audit', '--no-fund', '--ignore-scripts', '--legacy-peer-deps'], root, env);
}

function bootstrap(env) {
  installDependencies(env);
  run(env.POCKET_PYTHON, [join(root, 'scripts/prepare_upstream.py')], root, env);
  run('bun', ['install', '--frozen-lockfile'], join(root, '.cache/pocketjs'), env);
}

function nativeBuild(env) {
  run('cargo', ['build', '--locked', '--release', '--manifest-path', join(root, 'native/Cargo.toml'),
    '--bin', 'pocket_probe', '--bin', 'pocketjs_bytecode'], root, env);
}

function setupPrebuilt() {
  checkNodeVersion();
  installDependencies(process.env);
  // Local release archives allow the same npm-only flow before registry publication.
  const archive = `${platformPackageName().replace('@', '').replace('/', '-')}-${SDK_VERSION}.tgz`;
  const local = [join(root, 'prebuilt', archive), join(root, '.pocket-build', archive)].find(existsSync);
  let missing = false;
  try { resolvePrebuiltTools(root); }
  catch (error) { if (error.code !== 'POCKET_TOOLS_MISSING') throw error; missing = true; }
  if (missing && local && !process.env.POCKET_TOOLS_PACKAGE) {
    run(process.execPath, [process.env.npm_execpath, 'install', '--no-save', '--package-lock=false', '--ignore-scripts', '--no-audit', '--no-fund', '--legacy-peer-deps', local]);
  }
  const env = prebuiltEnvironment(root);
  check(env.POCKET_BUN, ['--version'], 'npm Bun');
  console.log(`[toolchain] 已校验 ${platformPackageName()}@${SDK_VERSION}，无需 Rust/Python/C++ 或全局 Bun`);
}

try {
  if (!actions.includes(action)) throw new Error(`usage: npm run <${actions.join('|')}> [-- build options]`);
  if (!['build:guest', 'run'].includes(action) && args.length) throw new Error(`${action} 不接受额外参数`);
  if (action.endsWith(':source')) {
    const env = { ...prerequisites(true), POCKET_SOURCE_BUILD: '1' };
    bootstrap(env);
    if (action !== 'bootstrap:source') nativeBuild(env);
  } else if (action === 'setup' || action === 'bootstrap') {
    setupPrebuilt();
  } else if (action === 'doctor' || action === 'build:probe') {
    const env = prebuiltEnvironment(root);
    check(env.POCKET_BUN, ['--version'], 'npm Bun');
    console.log(`[toolchain] 预编译工具、编译源码和 ABI/文件哈希检查通过：${resolvePrebuiltTools(root).root}`);
  } else {
    const env = prebuiltEnvironment(root);
    let script = 'scripts/build_guest.ts';
    if (action === 'run') {
      script = args.shift();
      if (!['pocket.ts', 'scripts/build_web.ts', 'scripts/build_wechat.ts', 'scripts/preview_wechat.ts', 'scripts/export_web_sdk.ts'].includes(script)) throw new Error('不支持的 SDK 入口');
    }
    run(env.POCKET_BUN, [join(root, script), ...args], root, env);
  }
} catch (error) {
  console.error(`[toolchain] ${error.message}`);
  process.exitCode = 1;
}
