import 'dart:convert';
import 'dart:io';

import 'package:crypto/crypto.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pocket_services/pocket_services.dart';
import 'package:pocket_studio/pocket_studio.dart';

/// Runs the REAL editor service (started by PocketStudioService through
/// `bun pocket.ts editor`) and drives it through the provider. Skips
/// explicitly without bun; a skip is not evidence.
void main() {
  final bun = Platform.environment['POCKET_BUN'] ??
      '${Platform.environment['HOME']}/.bun/bin/bun';
  final sdkRoot = Directory.current.parent.parent.path;
  final projectRoot = Platform.environment['POCKET_STUDIO_TEST_PROJECT'] ??
      <String>[Directory.current.parent.parent.parent.path, 'demo', 'js'].join('/');
  final studioProject = <String>[Directory.current.parent.parent.parent.path, 'studio', 'js'].join('/');
  final skip = File(bun).existsSync() && Directory(projectRoot).existsSync()
      ? false
      : 'bun or the sample project is not available';
  // POCKET_REQUIRE_REAL=1 turns a missing prerequisite into a failure (a skip is not evidence).
  final requireReal = Platform.environment['POCKET_REQUIRE_REAL'] == '1';
  if (requireReal && skip != false) {
    test('real service prerequisites are present (POCKET_REQUIRE_REAL=1)', () => fail('$skip'));
  }

  late Directory work;
  late PocketStudioConfig config;
  late PocketStudioService lifecycle;
  late PocketStudioPlugin plugin;

  setUpAll(() async {
    if (skip != false) return;
    work = await Directory.systemTemp.createTemp('pocket-studio-real-');
    final probe = await ServerSocket.bind(InternetAddress.loopbackIPv4, 0);
    final port = probe.port;
    await probe.close();
    config = PocketStudioConfig(
      port: port,
      sdkRoot: sdkRoot,
      projectRoot: projectRoot,
      workspace: '${work.path}/ws',
      bunExecutable: bun,
      extraProjectRoots: <String>[studioProject], // the Studio's own guest project: trusted host config
      environment: <String, String>{...Platform.environment, 'POCKET_SOURCE_BUILD': '1', 'TMPDIR': '/tmp'},
    );
    lifecycle = PocketStudioService(config, stopOnExit: false);
    await lifecycle.start();
    plugin = PocketStudioPlugin(config: config);
  });

  tearDownAll(() async {
    if (skip != false) return;
    await plugin.dispose();
    await lifecycle.stop();
    await work.delete(recursive: true);
  });

  Future<Map> call(String name, [Map<String, dynamic> params = const {}]) async =>
      (await plugin.invoke(name, params)) as Map;

  test('lifecycle started and owns the service; a second start attaches', () async {
    expect(lifecycle.ownsProcess, isTrue);
    final second = PocketStudioService(config, stopOnExit: false);
    await second.start();
    expect(second.ownsProcess, isFalse);
  }, skip: skip);

  test('the Studio\'s own guest project is listed through the trusted extra root; the update key exists at startup', () async {
    final list = (await call('studio.project.list'))['projects'] as List;
    final ids = list.map((p) => (p as Map)['id']);
    expect(ids, containsAll(<String>['pocket-host-showcase', 'pocket-studio']));
    final own = list.cast<Map>().firstWhere((p) => p['id'] == 'pocket-studio');
    expect(own['appId'], PocketStudioConfig.studioAppId);
    expect(jsonEncode(list), isNot(contains(studioProject)));
    final key = config.readUpdateKey();
    expect(key, isNotNull, reason: 'the service provisions the update signing key before the first publish');
    expect(File('${work.path}/ws/keys/editor-dev-key.json').readAsStringSync(), contains(key!.publicKey));
    expect(config.selfUpdateUrl, '${config.origin}/test/pocket/studio/dev.pocket.studio/latest.json');
  }, skip: skip);

  test('studio.service.health is scrubbed', () async {
    final health = await call('studio.service.health');
    expect(health['ok'], isTrue);
    final text = jsonEncode(health);
    expect(text, isNot(contains(sdkRoot)));
    expect(text, isNot(contains(projectRoot)));
    expect(text, isNot(contains('csrf')));
  }, skip: skip);

  test('studio.project.list and open list the project root', () async {
    final list = (await call('studio.project.list'))['projects'] as List;
    expect(list.map((p) => (p as Map)['id']), contains('pocket-host-showcase'));
    final open = await call('studio.project.open', {'project': 'pocket-host-showcase'});
    expect(open['id'], 'pocket-host-showcase');
    expect(jsonEncode(list), isNot(contains(projectRoot)));
  }, skip: skip, timeout: const Timeout(Duration(seconds: 60)));

  test('studio.fs.tree and read expose project files without absolute paths', () async {
    final tree = await call('studio.fs.tree', {'project': 'pocket-host-showcase'});
    final paths = (tree['files'] as List).map((f) => (f as Map)['path']).toList();
    expect(paths, containsAll(<String>['app.tsx', 'manifest.json']));
    final manifest = await call('studio.fs.read', {'project': 'pocket-host-showcase', 'path': 'manifest.json'});
    expect(manifest['content'], contains('capabilities'));
    final stat = await call('studio.fs.stat', {'project': 'pocket-host-showcase', 'path': 'app.tsx'});
    expect(stat['kind'], 'file');
    expect(jsonEncode(tree), isNot(contains(projectRoot)));
  }, skip: skip);

  test('file content round-trips byte-identical (verbatim content, no path scrubbing)', () async {
    await call('studio.project.create', {'id': 'studio-verbatim', 'template': 'app'});
    const content = "#!/usr/bin/env bun\nconst p='/tmp/x'; const t={a:/x/};\n-----BEGIN PRIVATE KEY-----\n";
    await call('studio.fs.write', {'project': 'studio-verbatim', 'path': 'v.ts', 'content': content});
    final read = await call('studio.fs.read', {'project': 'studio-verbatim', 'path': 'v.ts'});
    expect(read['content'], content);
    final chunk = await call('studio.fs.readChunk', {'project': 'studio-verbatim', 'path': 'v.ts', 'offset': 0});
    expect(base64Decode(chunk['data'] as String), utf8.encode(content));
    expect(chunk['sha256'], sha256.convert(utf8.encode(content)).toString());
  }, skip: skip);

  test('chunked read of a large file verifies against the whole-file sha256', () async {
    final file = File('$projectRoot/app.tsx');
    final bytes = file.readAsBytesSync();
    final chunk = await call('studio.fs.readChunk', {'project': 'pocket-host-showcase', 'path': 'app.tsx', 'offset': 0, 'length': 1000});
    expect(chunk['sha256'], sha256.convert(bytes).toString());
    expect(base64Decode(chunk['data'] as String), bytes.sublist(0, 1000));
    expect(chunk['totalBytes'], bytes.length);
  }, skip: skip);

  test('write path in a created project: CSRF, mkdir, rename, upload, delete, errors', () async {
    final created = await call('studio.project.create', {'id': 'studio-real', 'template': 'app'});
    expect(created['id'], 'studio-real');
    await call('studio.fs.write', {'project': 'studio-real', 'path': 'notes.ts', 'content': 'export const a = 1;\n'});
    expect((await call('studio.fs.read', {'project': 'studio-real', 'path': 'notes.ts'}))['content'], 'export const a = 1;\n');
    await call('studio.fs.mkdir', {'project': 'studio-real', 'path': 'src'});
    await call('studio.fs.rename', {'project': 'studio-real', 'from': 'notes.ts', 'to': 'src/notes.ts'});
    expect((await call('studio.fs.stat', {'project': 'studio-real', 'path': 'src/notes.ts'}))['kind'], 'file');

    final payload = utf8.encode('// big\n${'x' * 300000}\n');
    final sha = sha256.convert(payload).toString();
    final begin = await call('studio.fs.upload.begin', {'project': 'studio-real', 'path': 'src/big.ts', 'totalBytes': payload.length, 'sha256': sha});
    final id = begin['uploadId'] as String;
    for (var offset = 0; offset < payload.length; offset += pocketStudioChunkBytes) {
      final end = (offset + pocketStudioChunkBytes).clamp(0, payload.length);
      await call('studio.fs.upload.chunk', {'project': 'studio-real', 'uploadId': id, 'offset': offset, 'data': base64Encode(payload.sublist(offset, end))});
    }
    final commit = await call('studio.fs.upload.commit', {'project': 'studio-real', 'uploadId': id});
    expect(commit['sha256'], sha);
    await expectLater(plugin.invoke('studio.fs.read', {'project': 'studio-real', 'path': 'src/big.ts'}),
        throwsA(isA<PocketCapabilityException>().having((e) => e.code, 'code', 'too_large')));

    await call('studio.fs.delete', {'project': 'studio-real', 'path': 'src/big.ts'});
    await expectLater(plugin.invoke('studio.fs.read', {'project': 'studio-real', 'path': 'src/big.ts'}),
        throwsA(isA<PocketCapabilityException>().having((e) => e.code, 'code', 'not_found')));
    await expectLater(plugin.invoke('studio.fs.read', {'project': 'studio-real', 'path': 'editor.json'}),
        throwsA(isA<PocketCapabilityException>()));
    await expectLater(plugin.invoke('studio.fs.read', {'project': 'no-such-project', 'path': 'a.ts'}),
        throwsA(isA<PocketCapabilityException>().having((e) => e.code, 'code', 'not_found')));
  }, skip: skip, timeout: const Timeout(Duration(seconds: 60)));

  test('watch stream reports a real change; build.status is scrubbed', () async {
    final events = <Map>[];
    final seen = <String>[];
    final sub = plugin.openStream('studio.fs.watch', {'project': 'studio-real'}).listen((v) {
      for (final e in (v as Map)['events'] as List) {
        events.add(e as Map);
        seen.add((e)['type'] as String);
      }
    });
    await Future<void>.delayed(const Duration(milliseconds: 800));
    await call('studio.fs.write', {'project': 'studio-real', 'path': 'watched.ts', 'content': 'export {};\n'});
    for (var i = 0; i < 40 && !events.any((e) => e['type'] == 'change' && e['path'] == 'watched.ts'); i++) {
      await Future<void>.delayed(const Duration(milliseconds: 100));
    }
    await sub.cancel();
    expect(seen, contains('ready'));
    expect(events.any((e) => e['type'] == 'change' && e['path'] == 'watched.ts'), isTrue);
    final status = await call('studio.build.status', {'project': 'studio-real'});
    expect(jsonEncode(status), isNot(contains(work.path)));
  }, skip: skip, timeout: const Timeout(Duration(seconds: 60)));

  test('signed test publish through the provider: plan, publish, history, offline, artifacts, and no key material', () async {
    final started = await call('studio.build.start', {'project': 'studio-real'});
    expect(started['revision'], isA<int>(), reason: 'build.start returns the flat status');
    Map status = {};
    for (var i = 0; i < 300; i++) {
      status = await call('studio.build.status', {'project': 'studio-real'});
      if (status['busy'] != true && status['builtRevision'] != null) break;
      await Future<void>.delayed(const Duration(milliseconds: 200));
    }
    expect(status['error'], isNull, reason: '${status['logs']}');
    expect(status['builtRevision'], status['revision']);

    final plan = await call('studio.publish.plan', {'project': 'studio-real', 'channel': 'test'});
    final root = (plan['targets'] as List).first as Map;
    expect(root['kind'], 'root');
    expect(root['canPublish'], isTrue);
    final published = await call('studio.publish.publish', {'project': 'studio-real', 'channel': 'test'});
    final publish = (published['status'] as Map)['publish'] as Map;
    expect(publish['channel'], 'test');
    expect(publish['keyId'], isNotEmpty);
    expect(publish['payloadSha256'], hasLength(64));
    expect(published['manifestUrl'], contains('/test/pocket/'));
    expect((published['manifest'] as Map).containsKey('payload'), isFalse);
    final history = await call('studio.publish.history', {'project': 'studio-real'});
    final slots = (history['slots'] as List).cast<Map>();
    expect(slots.firstWhere((slot) => slot['name'] == 'test')['version'], publish['version']);
    expect((history['history'] as List), isNotEmpty);
    final offline = await call('studio.publish.offline', {'project': 'studio-real'});
    expect(offline['archiveUrl'], startsWith('/releases/studio-real/'));
    final list = await call('studio.artifacts.list', {'project': 'studio-real'});
    expect((list['artifacts'] as Map)['bytecode'], contains('app.qjbc'));
    final inspected = <Object?>[
      for (final name in const ['app.bytecode.json', 'guest-manifest.json', 'build.json', 'resources.json', 'app.qjbc', 'app.pak'])
        await call('studio.artifacts.inspect', {'project': 'studio-real', 'name': name}),
    ];
    expect((inspected[0] as Map)['data'], contains('runtimeAbi'));
    expect((inspected[3] as Map)['data'], contains('packages'));
    expect((inspected[4] as Map).containsKey('data'), isFalse);

    // Keys stay in the service: no field of the key file other than the public ones appears in any result.
    final keyFile = File('${work.path}/ws/keys/editor-dev-key.json');
    expect(keyFile.existsSync(), isTrue);
    final key = jsonDecode(keyFile.readAsStringSync()) as Map;
    final secrets = <String>[
      for (final entry in key.entries)
        if (!const {'keyId', 'publicKeyBase64', 'algorithm', 'createdAt'}.contains(entry.key) && entry.value is String && (entry.value as String).length >= 16) entry.value as String,
    ];
    expect(secrets, isNotEmpty, reason: 'the key file must hold private material for this check to mean anything: ${key.keys}');
    final everything = jsonEncode([plan, published, history, offline, list, inspected, status, await call('studio.build.status', {'project': 'studio-real'})]);
    for (final secret in secrets) {
      expect(everything, isNot(contains(secret)));
    }
    expect(everything, isNot(contains(work.path)));
  }, skip: skip, timeout: const Timeout(Duration(minutes: 3)));
}
