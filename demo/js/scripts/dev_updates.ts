/** Local signed releases for the Updates page. Private keys never enter assets. */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { generateDevKey, packageArtifacts } from '../../../sdk/scripts/package_update.ts';

const root = resolve(import.meta.dir, '..');
const sdkRoot = resolve(root, '..', '..', 'sdk');
const flutterRoot = resolve(root, '..');
const directory = join(root, '.pocket-updates');
const releases = join(directory, 'releases');
const published = join(directory, 'public');
const keyFile = join(directory, 'dev-key.json');
const args = process.argv.slice(2);
const command = args[0] ?? 'setup';
const version = args[1] ?? '2';

function publish(version: string): void {
  if (!['1', '2', 'broken'].includes(version)) throw new Error('version must be 1, 2, or broken');
  const envelope = join(releases, version, 'signed-manifest.json');
  if (!existsSync(envelope)) throw new Error('Run bun scripts/dev_updates.ts setup first');
  copyFileSync(envelope, join(published, 'latest.json'));
  console.log(`Published signed demo ${version}; press Check → Apply in the JS Updates page.`);
}

if (command === 'setup') {
  mkdirSync(releases, { recursive: true });
  mkdirSync(published, { recursive: true });
  if (!existsSync(keyFile)) generateDevKey(keyFile, 'pocket-local-demo');
  const key = JSON.parse(readFileSync(keyFile, 'utf8'));
  const sourcePath = join(root, '.pocket-build/app.js');
  if (!existsSync(sourcePath)) throw new Error('Run bun run build:guest before preparing releases');
  const original = readFileSync(sourcePath, 'utf8');
  // Hardware permission prompts also contain the app name. Change only the
  // compiled application title so a signed release has an observable version.
  const titleMarker = /(\b(?:var|let|const) demoTitle\s*=\s*)"Pocket Host Lab"/;
  if (!titleMarker.test(original)) throw new Error('Guest release title marker is missing');
  const metadata = JSON.parse(readFileSync(join(flutterRoot, 'assets/app.bytecode.json'), 'utf8'));
  const compiler = [
    'native/target/debug/pocketjs_bytecode',
    'native/target/release/pocketjs_bytecode',
    'native/target/aarch64-apple-darwin/release/pocketjs_bytecode',
  ].map(path => join(sdkRoot, path)).find(existsSync);
  if (!compiler) throw new Error('QuickJS bytecode compiler missing; run build:guest');
  for (const release of ['1', '2', 'broken']) {
    const releaseDir = join(releases, release);
    mkdirSync(releaseDir, { recursive: true });
    const source = join(releaseDir, 'app.js');
    const bytecode = join(releaseDir, 'app.qjbc');
    writeFileSync(source, release === 'broken'
      ? 'throw new Error("intentional signed demo startup failure");'
      : original.replace(titleMarker, `$1"Pocket Host Lab v${release}"`));
    const result = spawnSync(compiler, [
      '--input', source, '--output', bytecode,
      '--binding-generation', String(metadata.bindingGeneration),
      '--tick-hz', String(metadata.tickHz),
    ], { stdio: 'inherit' });
    if (result.status !== 0) throw new Error(`Bytecode compilation failed for ${release}`);
    const artifact = packageArtifacts({
      appId: 'pocket.host.demo', version: release === 'broken' ? 'broken' : `1.0.${release}`,
      build: release === 'broken' ? 3 : Number(release),
      bytecodePath: bytecode, entryFormat: 'quickjs-bytecode', runtimeAbi: metadata.runtimeAbi,
      pakPath: join(flutterRoot, 'assets/app.pak'), outDir: published, keyFile,
      guestManifestPath: join(root, 'manifest.json'),
    });
    copyFileSync(artifact.manifestPath, join(releaseDir, 'signed-manifest.json'));
  }
  writeFileSync(join(directory, 'host.json'), JSON.stringify({
    POCKET_UPDATE_URL: 'http://127.0.0.1:8787/latest.json',
    POCKET_UPDATE_KEY_ID: key.keyId,
    POCKET_UPDATE_PUBLIC_KEY: key.publicKeyBase64,
  }, null, 2) + '\n');
  publish(version);
  console.log('Start server: bun ../../sdk/scripts/serve_updates.ts --root .pocket-updates/public');
  console.log('Launch from demo/: flutter run -d macos --dart-define-from-file=js/.pocket-updates/host.json');
} else if (command === 'publish') {
  publish(version);
} else {
  throw new Error('Usage: bun scripts/dev_updates.ts setup [1|2|broken] | publish 1|2|broken');
}
