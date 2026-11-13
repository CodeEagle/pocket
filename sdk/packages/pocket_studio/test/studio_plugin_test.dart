import 'dart:async';
import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:pocket_services/pocket_services.dart';
import 'package:pocket_studio/pocket_studio.dart';

import 'fake_service.dart';

void main() {
  late FakeService service;
  late PocketStudioPlugin plugin;

  setUp(() async {
    service = await FakeService.start();
    plugin = PocketStudioPlugin(
      config: PocketStudioConfig(port: service.port, sdkRoot: '/opt/pocket/sdk'),
      flushInterval: const Duration(milliseconds: 5),
    );
  });
  tearDown(() async {
    await plugin.dispose();
    await service.close();
  });

  Future<Object?> call(String name, [Map<String, dynamic> params = const {}]) => plugin.invoke(name, params);
  Future<PocketCapabilityException> failure(String name, Map<String, dynamic> params) async {
    try {
      await call(name, params);
    } on PocketCapabilityException catch (error) {
      return error;
    }
    fail('$name should have failed');
  }

  group('routing', () {
    test('project.list slims status and wraps the array', () async {
      service.handler = (r) async => FakeReply(200, [
        {
          'id': 'demo', 'name': 'Demo',
          'status': {'revision': 3, 'logs': List.filled(50, 'x' * 100), 'busy': false},
        },
      ]);
      final result = await call('studio.project.list') as Map;
      final project = (result['projects'] as List).single as Map;
      expect(project['id'], 'demo');
      expect((project['status'] as Map)['logs'], isEmpty);
      expect(service.requests.last.method, 'GET');
      expect(service.requests.last.uri.path, '/api/projects');
    });

    test('fs.read url-encodes each segment and maps the method', () async {
      service.handler = (r) async => FakeReply(200, {'path': 'src/a b.tsx', 'content': 'hi', 'bytes': 2, 'revision': 1});
      await call('studio.fs.read', {'project': 'demo', 'path': 'src/a b.tsx'});
      expect(service.requests.last.uri.toString(), '/api/projects/demo/files/src/a%20b.tsx');
      await call('studio.fs.stat', {'project': 'demo', 'path': 'src/中.ts'});
      expect(service.requests.last.uri.path, startsWith('/api/projects/demo/stat/src/%E4%B8%AD'));
    });

    test('every mapped call hits its fixed route', () async {
      service.handler = (r) async => const FakeReply(200, {'ok': true});
      final cases = <String, (Map<String, dynamic>, String, String)>{
        'studio.project.open': ({'project': 'demo'}, 'GET', '/api/projects/demo'),
        'studio.project.settings.get': ({'project': 'demo'}, 'GET', '/api/projects/demo/config'),
        'studio.project.settings.set': ({'project': 'demo', 'settings': {'title': 'T'}}, 'PUT', '/api/projects/demo/config'),
        'studio.fs.tree': ({'project': 'demo'}, 'GET', '/api/projects/demo/files'),
        'studio.fs.write': ({'project': 'demo', 'path': 'a.ts', 'content': 'x'}, 'PUT', '/api/projects/demo/files/a.ts'),
        'studio.fs.rename': ({'project': 'demo', 'from': 'a.ts', 'to': 'b.ts'}, 'POST', '/api/projects/demo/files-move'),
        'studio.fs.delete': ({'project': 'demo', 'path': 'a.ts'}, 'DELETE', '/api/projects/demo/files/a.ts'),
        'studio.fs.mkdir': ({'project': 'demo', 'path': 'd'}, 'POST', '/api/projects/demo/folders'),
        'studio.fs.rmdir': ({'project': 'demo', 'path': 'd'}, 'DELETE', '/api/projects/demo/folders/d'),
        'studio.fs.readChunk': ({'project': 'demo', 'path': 'a.ts', 'offset': 0}, 'GET', '/api/projects/demo/chunks/a.ts'),
        'studio.fs.upload.begin': ({'project': 'demo', 'path': 'a.ts', 'totalBytes': 1, 'sha256': 'a' * 64}, 'POST', '/api/projects/demo/uploads'),
        'studio.fs.upload.chunk': ({'project': 'demo', 'uploadId': 'u-1', 'offset': 0, 'data': 'QQ=='}, 'PUT', '/api/projects/demo/uploads/u-1'),
        'studio.fs.upload.commit': ({'project': 'demo', 'uploadId': 'u-1'}, 'POST', '/api/projects/demo/uploads/u-1/commit'),
        'studio.fs.upload.abort': ({'project': 'demo', 'uploadId': 'u-1'}, 'DELETE', '/api/projects/demo/uploads/u-1'),
        'studio.build.start': ({'project': 'demo'}, 'POST', '/api/projects/demo/build'),
        'studio.build.cancel': ({'project': 'demo'}, 'POST', '/api/projects/demo/build/cancel'),
        'studio.build.status': ({'project': 'demo'}, 'GET', '/api/projects/demo/status'),
        'studio.logs.tail': ({'project': 'demo'}, 'GET', '/api/projects/demo/logs'),
        'studio.preview.publish': ({'project': 'demo'}, 'POST', '/api/projects/demo/preview-publish'),
        'studio.preview.devices': (const {}, 'GET', '/api/devices'),
        'studio.preview.deploy': ({'project': 'demo', 'deviceId': 'sim'}, 'POST', '/api/projects/demo/deploy'),
        'studio.preview.deployStatus': ({'project': 'demo', 'job': 'deployment-1'}, 'GET', '/api/projects/demo/deploy/deployment-1'),
        'studio.preview.deployCancel': ({'project': 'demo', 'job': 'deployment-1'}, 'DELETE', '/api/projects/demo/deploy/deployment-1'),
        'studio.publish.plan': ({'project': 'demo'}, 'GET', '/api/projects/demo/publish-targets'),
        'studio.publish.publish': ({'project': 'demo', 'channel': 'release'}, 'POST', '/api/projects/demo/publish'),
        'studio.publish.history': ({'project': 'demo'}, 'GET', '/api/projects/demo/versions'),
        'studio.publish.offline': ({'project': 'demo'}, 'POST', '/api/projects/demo/package-offline'),
        'studio.artifacts.list': ({'project': 'demo'}, 'GET', '/api/projects/demo/status'),
        'studio.service.health': (const {}, 'GET', '/health'),
        'studio.service.upgrade.status': (const {}, 'GET', '/api/studio/upgrade'),
      };
      for (final entry in cases.entries) {
        service.requests.clear();
        await call(entry.key, entry.value.$1);
        final r = service.requests.where((q) => q.uri.path != '/health' || entry.key == 'studio.service.health').last;
        expect('${r.method} ${r.uri.path}', '${entry.value.$2} ${entry.value.$3}', reason: entry.key);
      }
    });

    test('fs.tree can merge assets; readChunk clamps length', () async {
      service.handler = (r) async => r.uri.path.endsWith('/assets')
          ? const FakeReply(200, {'assets': ['a.png']})
          : const FakeReply(200, {'files': [], 'revision': 2});
      final tree = await call('studio.fs.tree', {'project': 'demo', 'assets': true}) as Map;
      expect(tree['assets'], ['a.png']);
      await call('studio.fs.readChunk', {'project': 'demo', 'path': 'a.ts', 'offset': 5, 'length': 9999999});
      expect(service.requests.last.uri.queryParameters, {'offset': '5', 'length': '131072'});
    });

    test('oversized results fail with too_large instead of the framework quota', () async {
      service.handler = (r) async => FakeReply(200, {'path': 'a.ts', 'content': 'x' * 300000, 'bytes': 300000, 'revision': 1});
      final error = await failure('studio.fs.read', {'project': 'demo', 'path': 'a.ts'});
      expect(error.code, 'too_large');
      expect(error.message, contains('readChunk'));
    });

    test('artifact inspect returns scrubbed text and no binary data', () async {
      service.handler = (r) async => r.uri.path.endsWith('build.json')
          ? FakeReply(200, null, raw: utf8.encode('{"source":"/Users/dev/ws/projects/demo/app.tsx"}'), contentType: 'application/json')
          : FakeReply(200, null, raw: [1, 2, 3], contentType: 'application/octet-stream');
      final text = await call('studio.artifacts.inspect', {'project': 'demo', 'name': 'build.json'}) as Map;
      expect(text['data'], contains('<project>/app.tsx'));
      expect(text['data'], isNot(contains('/Users')));
      final binary = await call('studio.artifacts.inspect', {'project': 'demo', 'name': 'app.qjbc'}) as Map;
      expect(binary.containsKey('data'), isFalse);
      expect((await failure('studio.artifacts.inspect', {'project': 'demo', 'name': '../x'})).code, 'invalid_params');
    });
  });

  group('validation (no request may reach the service)', () {
    for (final path in ['/etc/passwd', '../x', 'a/../b', 'a//b', 'a/./b', 'a\\b', 'a\u0000b', 'C:/x', '', 'a/%2e%2e/b', 'a/%2F', 'a/']) {
      test('rejects path ${jsonEncode(path)}', () async {
        service.requests.clear();
        final error = await failure('studio.fs.read', {'project': 'demo', 'path': path});
        expect(error.code, 'invalid_params');
        expect(service.requests.where((r) => r.uri.path != '/health'), isEmpty);
      });
    }
    for (final id in ['../demo', 'Demo', 'a/b', '', '1x', 'a' * 49]) {
      test('rejects project id ${jsonEncode(id)}', () async {
        expect((await failure('studio.build.status', {'project': id})).code, 'invalid_params');
      });
    }
    test('rejects bad parameters and unknown settings', () async {
      expect((await failure('studio.fs.upload.chunk', {'project': 'demo', 'uploadId': 'u', 'offset': 0, 'data': base64Encode(List.filled(131073, 1))})).code, 'too_large');
      expect((await failure('studio.fs.upload.begin', {'project': 'demo', 'path': 'a.ts', 'totalBytes': 1, 'sha256': 'zz'})).code, 'invalid_params');
      expect((await failure('studio.fs.readChunk', {'project': 'demo', 'path': 'a.ts', 'offset': -1})).code, 'invalid_params');
      expect((await failure('studio.project.settings.set', {'project': 'demo', 'settings': {'entry': '../x'}})).code, 'invalid_params');
      expect((await failure('studio.project.create', {'id': 'x', 'template': 'evil'})).code, 'invalid_params');
      expect((await failure('studio.publish.plan', {'project': 'demo', 'channel': 'beta'})).code, 'invalid_params');
      expect((await failure('studio.fs.write', {'project': 'demo', 'path': 'a.ts', 'content': 'x' * (200 * 1024)})).code, 'too_large');
      expect((await failure('studio.fs.read', {'path': 'a.ts'})).code, 'invalid_params');
      expect((await failure('studio.nope', {})).code, 'capability_not_found');
      expect(service.requests, isEmpty);
    });
  });

  group('csrf', () {
    test('writes carry x-pocket-csrf from /health, never x-pocket-editor, and the token is not returned', () async {
      service.handler = (r) async => const FakeReply(200, {'path': 'a.ts', 'bytes': 1, 'revision': 2});
      final result = await call('studio.fs.write', {'project': 'demo', 'path': 'a.ts', 'content': 'x'});
      final write = service.requests.last;
      expect(write.headers.value('x-pocket-csrf'), service.csrf);
      expect(write.headers.value('x-pocket-editor'), isNull);
      expect(write.headers.contentType?.mimeType, 'application/json');
      expect(jsonEncode(result), isNot(contains(service.csrf)));
      expect(jsonEncode(await call('studio.service.health')), isNot(contains(service.csrf)));
    });

    test('reads send no write credential', () async {
      service.handler = (r) async => const FakeReply(200, {'files': [], 'revision': 1});
      await call('studio.fs.tree', {'project': 'demo'});
      expect(service.requests.last.headers.value('x-pocket-csrf'), isNull);
    });

    test('403 triggers exactly one refresh', () async {
      var token = service.csrf;
      service.handler = (r) async => r.headers.value('x-pocket-csrf') == token ? const FakeReply(202, {'busy': true}) : const FakeReply(403, {'error': 'bad token'});
      await call('studio.build.start', {'project': 'demo'});
      token = service.csrf = 'rotated-token-000000';
      await call('studio.build.start', {'project': 'demo'});
      expect(service.requests.last.headers.value('x-pocket-csrf'), 'rotated-token-000000');
      service.handler = (r) async => const FakeReply(403, {'error': 'nope'});
      expect((await failure('studio.build.start', {'project': 'demo'})).code, 'forbidden');
    });
  });

  group('scrubbing', () {
    test('health drops roots and token', () async {
      final health = await call('studio.service.health') as Map;
      expect(health.keys, containsAll(['ok', 'service', 'version']));
      final text = jsonEncode(health);
      for (final leak in ['/Users', 'workspace', 'projectRoot', 'flutterRoot', 'csrf']) {
        expect(text, isNot(contains(leak)));
      }
    });

    test('status.error, logs and diagnostics are scrubbed', () async {
      service.handler = (r) async => const FakeReply(200, {
        'id': 'demo', 'revision': 2, 'builtRevision': 1, 'busy': false,
        'error': 'Build failed: /Users/dev/ws/projects/demo/app.tsx:3:4 not found',
        'logs': [
          'build_guest: source=/tmp/pocket-abc/app.tsx',
          'cache /private/var/folders/xx/T/pocket-1/out ok',
          'toolchain /opt/pocket/sdk/.cache/bun',
          'flutter at /Users/dev/flutter/bin/flutter',
          'win C:\\Users\\dev\\x.ts here',
          'url http://127.0.0.1:8795/api/projects/demo/status fine',
          'relative src/tmp/x.ts stays',
        ],
      });
      final status = await call('studio.build.status', {'project': 'demo'}) as Map;
      expect(status['error'], 'Build failed: <project>/app.tsx:3:4 not found');
      final logs = (status['logs'] as List).cast<String>();
      expect(logs[0], 'build_guest: source=<path>/app.tsx');
      expect(logs[1], contains('<path>'));
      expect(logs[2], 'toolchain <sdk>/.cache/bun');
      expect(logs[3], 'flutter at <flutter>/bin/flutter');
      expect(logs[4], contains('<path>'));
      expect(logs[5], 'url http://127.0.0.1:8795/api/projects/demo/status fine');
      expect(logs[6], 'relative src/tmp/x.ts stays');
      expect(jsonEncode(status), isNot(contains('/Users')));
    });

    test('service error messages are scrubbed', () async {
      service.handler = (r) async => const FakeReply(400, {'error': 'cannot open /Users/dev/ws/projects/demo/x'});
      final error = await failure('studio.fs.stat', {'project': 'demo', 'path': 'x.ts'});
      expect(error.code, 'invalid_request');
      expect(error.message, 'cannot open <project>/x (HTTP 400)');
    });

    test('scrubber unit rules', () {
      final s = StudioPathScrubber()..addRoot('/var/folders/ab/T', '<tmp>')..addSecret('supersecrettoken');
      expect(s.scrubString('x /private/var/folders/ab/T/a/b y'), 'x <tmp>/a/b y');
      expect(s.scrubString('tok supersecrettoken'), 'tok <redacted>');
      expect(s.scrubString('file:///Users/me/a.ts'), 'file://<path>');
      expect(s.scrubJson({'workspace': '/x', 'a': {'projectRoot': '/y', 'b': 1}, 'l': ['/home/u/z.txt']}),
          {'a': {'b': 1}, 'l': ['<path>/z.txt']});
    });
  });

  group('error mapping', () {
    final statuses = {400: 'invalid_request', 403: 'forbidden', 404: 'not_found', 409: 'conflict', 413: 'too_large', 422: 'checksum_mismatch', 429: 'too_many_requests', 501: 'unsupported', 500: 'service_error', 502: 'service_error'};
    statuses.forEach((status, code) {
      test('HTTP $status -> $code', () async {
        service.handler = (r) async => FakeReply(status, {'error': 'boom'});
        final error = await failure('studio.build.status', {'project': 'demo'});
        expect(error.code, code);
        expect(error.message, 'boom (HTTP $status)');
      });
    });
    test('unreachable service', () async {
      await service.close();
      expect((await failure('studio.build.status', {'project': 'demo'})).code, 'service_unreachable');
      service = await FakeService.start();
    });
    test('non-JSON error body', () async {
      service.handler = (r) async => FakeReply(500, null, raw: utf8.encode('Internal /Users/x/y'), contentType: 'text/plain');
      final error = await failure('studio.build.status', {'project': 'demo'});
      expect(error.message, isNot(contains('/Users')));
    });
  });

  group('streams', () {
    Future<List<Map>> collect(String name, {int events = 1, Duration wait = const Duration(seconds: 2)}) async {
      final batches = <Map>[];
      final done = Completer<void>();
      final sub = plugin.openStream(name, {'project': 'demo'}).listen((v) {
        batches.add(v as Map);
        if (batches.expand((b) => b['events'] as List).length >= events && !done.isCompleted) done.complete();
      }, onError: (Object e) => done.completeError(e), onDone: () { if (!done.isCompleted) done.complete(); });
      await done.future.timeout(wait);
      await sub.cancel();
      return batches;
    }

    test('watch maps SSE events, scrubs them and batches', () async {
      service.handler = (r) async => const FakeReply(200, null, sseClose: true, sse: [
        {'type': 'ready', 'revision': 1},
        {'type': 'change', 'path': 'a.ts', 'kind': 'file', 'event': 'change'},
        {'type': 'status', 'status': {'error': 'x /Users/dev/ws/projects/demo/a.ts'}},
      ]);
      final batches = await collect('studio.fs.watch', events: 3);
      final events = batches.expand((b) => b['events'] as List).cast<Map>().toList();
      expect(events.map((e) => e['type']), ['ready', 'change', 'status']);
      expect(jsonEncode(events), isNot(contains('/Users')));
      expect(service.requests.last.uri.path, '/api/projects/demo/watch');
    });

    test('overflow drops oldest log events and surfaces a gap marker', () async {
      final lines = [
        {'type': 'status', 'status': {'busy': true}},
        for (var i = 0; i < 3000; i++) {'type': 'log', 'line': 'line $i'},
        {'type': 'done', 'ok': true},
      ];
      service.handler = (r) async => FakeReply(200, null, sse: lines);
      final batches = await collect('studio.build.events', events: 5000);
      final events = batches.expand((b) => b['events'] as List).cast<Map>().toList();
      expect(events.any((e) => e['type'] == 'gap' && (e['dropped'] as int) > 0), isTrue);
      expect(events.last['type'], 'done');
      expect(events.first['type'], anyOf('gap', 'status'));
      for (final b in batches) {
        expect((b['events'] as List).length, lessThanOrEqualTo(201));
        expect(utf8.encode(jsonEncode(b)).length, lessThan(256 * 1024));
      }
    });

    test('service error becomes a stream error; cancel releases the connection', () async {
      service.handler = (r) async => const FakeReply(429, {'error': 'too many watchers'});
      final stream = plugin.openStream('studio.fs.watch', {'project': 'demo'});
      await expectLater(stream, emitsError(isA<PocketCapabilityException>().having((e) => e.code, 'code', 'too_many_requests')));

      service.handler = (r) async => const FakeReply(200, null, sseClose: false, sse: [{'type': 'ready', 'revision': 1}]);
      final sub = plugin.openStream('studio.fs.watch', {'project': 'demo'}).listen((_) {});
      await Future<void>.delayed(const Duration(milliseconds: 300));
      expect(service.sseOpen, isNotEmpty);
      await sub.cancel();
      await Future<void>.delayed(const Duration(milliseconds: 300));
      expect(service.sseClosed, greaterThan(0));
    });
  });

  group('plugin admission', () {
    Future<PocketPluginManager> admit({required Set<String> host, String appId = 'dev.pocket.studio'}) async {
      final registry = PocketHostRegistry();
      final h = PocketHost(
        registry: registry,
        streams: PocketStreamBridge(send: (_, __) => true),
        allowedCapabilities: pocketStudioCapabilityNames,
        send: (_, __) => true,
      );
      final manager = PocketPluginManager(host: h, appId: appId, sessionId: '1', allowedPermissions: host);
      manager.register(plugin);
      final availability = manager.negotiate(
        required: const [],
        optional: pocketStudioCapabilityNames.toList(),
        requestedPermissions: PocketStudioPermissions.all.toList(),
      );
      await manager.activate(availability);
      addTearDown(manager.dispose);
      return manager;
    }

    test('descriptor serializes with schemas', () {
      final json = plugin.descriptor.toJson();
      expect((json['capabilities'] as List).length, pocketStudioCapabilityNames.length);
    });

    test('granted host scope works; ungranted permission is denied before any request', () async {
      service.handler = (r) async => const FakeReply(200, {'files': [], 'revision': 1});
      final manager = await admit(host: {'studio.read'});
      expect(await manager.invoke('studio.fs.tree', {'project': 'demo'}), isA<Map>());
      service.requests.clear();
      await expectLater(manager.invoke('studio.fs.write', {'project': 'demo', 'path': 'a.ts', 'content': 'x'}),
          throwsA(isA<PocketCapabilityException>()));
      expect(service.requests, isEmpty);
    });

    test('a host scope without any studio permission (preview child) is denied', () async {
      final manager = await admit(host: const <String>{}, appId: 'dev.pocket.studio.preview');
      await expectLater(manager.invoke('studio.project.list', {}), throwsA(isA<PocketCapabilityException>()));
      expect(service.requests, isEmpty);
    });
  });

  group('lifecycle', () {
    test('attaches to an already healthy service without spawning', () async {
      final lifecycle = PocketStudioService(PocketStudioConfig(port: service.port));
      await lifecycle.start();
      expect(lifecycle.ownsProcess, isFalse);
      await lifecycle.stop();
    });

    test('fails clearly when nothing runs and autoStart is off or unconfigured', () async {
      final port = service.port;
      await service.close();
      expect(() => PocketStudioService(PocketStudioConfig(port: port, autoStart: false)).start(),
          throwsA(isA<PocketStudioServiceException>().having((e) => e.code, 'code', 'service_unavailable')));
      expect(() => PocketStudioService(PocketStudioConfig(port: port)).start(),
          throwsA(isA<PocketStudioServiceException>().having((e) => e.code, 'code', 'config_missing')));
      service = await FakeService.start();
    });

    test('a non-editor listener on the port is not attached to', () async {
      service.health = {'ok': true, 'service': 'something-else'};
      expect(() => PocketStudioService(PocketStudioConfig(port: service.port)).start(),
          throwsA(isA<PocketStudioServiceException>()));
    });
  });
}
