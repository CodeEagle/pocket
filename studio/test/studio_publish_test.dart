import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pocket_flutter/pocket_flutter.dart';
import 'package:pocket_sdk/pocket_sdk.dart';
import 'package:pocket_services/pocket_services.dart';
import 'package:pocket_studio/pocket_studio.dart';
import 'package:pocket_studio_app/main.dart';

/// M5 exit test (Linux part): "publish a signed test update from Studio and prove a client activates it".
///
/// Everything is real: the native runtime running the Studio bytecode, the host's grants and plugins
/// (studio.* provider, clipboard), a real editor service (pinned compiler, real Ed25519 signing, real
/// version journal) started on a TEMP project, and, for the client, the SDK's own update path: a host that
/// ships build 1 of the app (the first Studio build, `BASELINE_V0`) and is pointed at the service's test slot
/// (`PocketHostConfig.load` -> `PocketUpdateCoordinator.prepare/activate`: signed manifest, every blob hash, ABI,
/// downgrade floor, size limits, activation) and a second native runtime that runs the downloaded bytecode.
/// `PocketSession` is not used for the download because a cold session picks the bundle (.7z) delivery, which needs
/// the `pocket_archive` platform plugin that has no Linux implementation; the coordinator's granular mode is the same
/// verification and storage code without the archive step. The Studio guest is driven only by pointer taps
/// on labels it draws; the test never calls a studio.* capability for the publish itself.
///
/// Facts observed: the Studio screens (plan, result, versions), the clipboard after tapping 复制, the
/// service's version journal read over HTTP, the client's activated package (version/build), the client's
/// own frame text and an input-driven frame change, and that no key material or absolute path ever
/// crossed to the guest.
/// POCKET_REQUIRE_REAL=1 turns a missing prerequisite into a failure instead of a skip.
void requireReal(Object? skipReason) {
  if (skipReason != null && skipReason != false && Platform.environment['POCKET_REQUIRE_REAL'] == '1') {
    fail('POCKET_REQUIRE_REAL=1: $skipReason');
  }
}

void main() {
  final binding = TestWidgetsFlutterBinding.ensureInitialized();
  HttpOverrides.global = null;
  final nativeLibrary = Platform.environment['POCKET_NATIVE_LIBRARY'];
  final bun = Platform.environment['POCKET_BUN'] ?? '${Platform.environment['HOME']}/.bun/bin/bun';
  final repo = Directory.current.parent.path;
  final skip = nativeLibrary == null
      ? 'POCKET_NATIVE_LIBRARY is not set'
      : !File(bun).existsSync()
      ? 'bun executable not found (set POCKET_BUN)'
      : false;
  requireReal(skip);

  late Directory work;
  late Directory project;
  late PocketStudioConfig config;
  late PocketStudioService service;

  setUpAll(() async {
    if (skip != false) return;
    work = await Directory.systemTemp.createTemp('studio-publish-');
    project = Directory('${work.path}/pub-app')..createSync();
    File('${project.path}/pocket.json').writeAsStringSync(jsonEncode({'app': {'entry': 'app.tsx'}, 'version': '1.0.0', 'build': 1}));
    File('${project.path}/editor.json').writeAsStringSync(jsonEncode({
      'id': 'pub-app', 'appId': 'pocket.pub', 'name': 'Pub App', 'title': 'Pub App',
      'version': '1.0.0', 'build': 1, 'tickHz': 60, 'entry': 'app.tsx', 'output': 'app', 'framework': 'solid',
    }));
    File('${project.path}/manifest.json').writeAsStringSync('{"capabilities":{"requires":[]}}');
    File('${project.path}/app.tsx').writeAsStringSync(_source('BASELINE_V0'));
    final probe = await ServerSocket.bind(InternetAddress.loopbackIPv4, 0);
    final port = probe.port;
    await probe.close();
    config = PocketStudioConfig(
      port: port,
      sdkRoot: '$repo/sdk',
      projectRoot: project.path,
      workspace: '${work.path}/ws',
      bunExecutable: bun,
      environment: {...Platform.environment, 'POCKET_SOURCE_BUILD': '1', 'TMPDIR': '/tmp'},
    );
    service = PocketStudioService(config, stopOnExit: false);
    await service.start();
  });

  tearDownAll(() async {
    if (skip != false) return;
    await service.stop();
    await work.delete(recursive: true);
  });

  test('publish a signed test update from the Studio guest by taps; a client downloads, verifies and runs it', () async {
    final messenger = binding.defaultBinaryMessenger;
    final support = await Directory.systemTemp.createTemp('studio-publish-support-');
    messenger.setMockMethodCallHandler(const MethodChannel('plugins.flutter.io/path_provider'), (_) async => support.path);
    // The test binding has no real system clipboard: a recording stand-in for the platform channel the plugin calls.
    String? clipboardText;
    messenger.setMockMethodCallHandler(SystemChannels.platform, (call) async {
      switch (call.method) {
        case 'Clipboard.setData':
          clipboardText = (call.arguments as Map)['text'] as String?;
          return null;
        case 'Clipboard.getData':
          return clipboardText == null ? null : <String, Object?>{'text': clipboardText};
        case 'Clipboard.hasStrings':
          return <String, Object?>{'value': clipboardText != null};
      }
      return null;
    });
    addTearDown(() async {
      messenger.setMockMethodCallHandler(SystemChannels.platform, null);
      messenger.setMockMethodCallHandler(const MethodChannel('plugins.flutter.io/path_provider'), null);
      if (support.existsSync()) await support.delete(recursive: true);
    });

    // ------------------------------------------------------------------ the Studio guest on the real runtime
    final ui = studioSystemUI(config);
    final assets = '$repo/studio/assets';
    final entry = Uint8List.fromList(await File('$assets/app.qjbc').readAsBytes());
    final pak = Uint8List.fromList(await File('$assets/app.pak').readAsBytes());
    final metadata = jsonDecode(await File('$assets/app.bytecode.json').readAsString()) as Map;
    final manifest = PocketGuestManifest.fromJsonString(await File('$assets/guest-manifest.json').readAsString());

    final runtime = FfiPocketRuntime.open(width: 900, height: 700);
    expect(syncPocketHostFonts(runtime), isTrue);
    final toGuest = <String>[]; // every payload the host ever sent to the guest (responses, stream data)
    bool send(String method, Map<String, dynamic> params) {
      toGuest.add(jsonEncode(params));
      runtime.send(<String, dynamic>{'type': 'event', 'name': method, 'payload': params});
      return true;
    }

    final providers = [for (final factory in ui.pluginFactories) factory(PocketViewController())];
    final host = PocketHost(
      registry: PocketHostRegistry(),
      streams: PocketStreamBridge(send: send),
      allowedCapabilities: {for (final p in providers) ...p.descriptor.capabilities.keys},
      send: send,
    );
    final manager = PocketPluginManager(host: host, appId: ui.appId, sessionId: 'studio-publish', allowedPermissions: ui.allowedPermissions);
    for (final provider in providers) {
      manager.register(provider);
    }
    await manager.activate(manager.negotiate(
      required: manifest.requiredCapabilities.where((c) => c.startsWith('studio.')),
      optional: manifest.optionalCapabilities,
      requestedPermissions: manifest.declaredPermissions,
    ));

    var frame = runtime.loadBytecode(entry, pak, expectedRuntimeAbi: metadata['runtimeAbi'] as String);
    Future<void> pump([int count = 1]) async {
      for (var i = 0; i < count; i++) {
        for (final event in frame.events) {
          if (event.method == 'host.request' || event.method.startsWith('stream.')) unawaited(host.handle(event));
        }
        await Future<void>.delayed(const Duration(milliseconds: 4));
        frame = runtime.frame(16);
      }
    }

    String textOf() => frame.ops.whereType<PocketTextOp>().map((op) => op.text).join('\n');
    Future<void> until(bool Function() ok, String what, {Duration timeout = const Duration(seconds: 60)}) async {
      final clock = Stopwatch()..start();
      while (clock.elapsed < timeout && !ok()) {
        await pump();
      }
      if (!ok()) {
        final status = await _getJson(config.port, '/api/projects/pub-app/status');
        final interesting = (status['logs'] as List).where((l) => !'$l'.startsWith('warning') && !'$l'.startsWith('PocketJS') && !'$l'.startsWith('build_guest')).toList();
        fail('timed out waiting for $what\nservice: revision=${status['revision']} built=${status['builtRevision']} busy=${status['busy']} error=${status['error']}\nlogs: ${jsonEncode(interesting)}\n${textOf()}');
      }
    }

    Future<void> tap(String label, {int nth = 0}) async {
      final ops = frame.ops.whereType<PocketTextOp>().where((o) => o.text == label).toList();
      if (ops.length <= nth) throw StateError('no "$label" #$nth in\n${textOf()}');
      final op = ops[nth];
      final point = {'id': 0, 'x': op.x + (op.width / 2 < 60 ? op.width / 2 : 40), 'y': op.y + (op.height / 2 < 20 ? op.height / 2 : 10)};
      await pump(10);
      for (final phase in const ['down', 'up']) {
        runtime.send({'type': 'event', 'name': 'input.pointer', 'payload': {...point, 'phase': phase}});
        await pump(2);
      }
    }

    final keyFile = File('${work.path}/ws/keys/editor-dev-key.json');
    FfiPocketRuntime? clientRuntime;
    try {
      await until(() => textOf().contains('Pub App'), 'project list');
      await tap('Pub App');
      await until(() => textOf().contains('app.tsx'), 'file tree');

      // Build through the Console page, like a user; `rev` is the source revision that must end up built.
      Future<void> buildViaStudio() async {
        await tap('控制台');
        await until(() => textOf().contains('开始构建'), 'console page');
        await tap('开始构建');
        late Map<String, dynamic> status;
        final clock = Stopwatch()..start();
        do {
          await pump(3);
          status = await _getJson(config.port, '/api/projects/pub-app/status');
        } while (clock.elapsed < const Duration(seconds: 150) && !(status['busy'] == false && status['builtRevision'] == status['revision'] && status['error'] == null));
        expect(status['builtRevision'], status['revision'], reason: 'the service built the current source: ${status['error']}');
        await until(() => textOf().contains('已构建（最新）'), 'the Console to show the finished build');
      }

      // Build 1: the app as first shipped. The host embeds it (as a real app embeds its shipped package).
      await buildViaStudio();
      final built0 = (await _getJson(config.port, '/api/projects/pub-app/status'))['builtRevision'];
      final baselineDir = Directory('${work.path}/baseline')..createSync();
      for (final name in const ['app.qjbc', 'app.pak', 'app.bytecode.json', 'guest-manifest.json']) {
        File('${work.path}/ws/builds/pub-app/$built0/$name').copySync('${baselineDir.path}/$name');
      }
      expect((jsonDecode(File('${baselineDir.path}/app.bytecode.json').readAsStringSync()) as Map)['build'], 1);

      // The new version: edited through the service as an external editor would, then built again from the Studio.
      final writer = PocketStudioPlugin(config: config);
      await writer.invoke('studio.fs.write', {'project': 'pub-app', 'path': 'app.tsx', 'content': _source('PUBLISHED_V1')});
      await buildViaStudio();

      // ---- Publish page: plan, then a signed test publish by tap ------------------------------------------
      await tap('发布');
      await until(() => textOf().contains('已构建（可发布）'), 'publish plan');
      expect(textOf(), contains('Pub App（pocket.pub）'));
      expect(textOf(), contains('尚无发布记录'));
      expect(textOf(), contains('槽位所有者'));
      await tap('发布测试包');
      await until(() => textOf().contains('发布完成 · 测试'), 'the signed publish to finish');
      final screen1 = textOf();
      final published = await _getJson(config.port, '/api/projects/pub-app/versions');
      final testSlot = (published['slots'] as List).cast<Map>().firstWhere((s) => s['name'] == 'test');
      final version1 = testSlot['version'] as String;
      final build1 = testSlot['build'] as int;
      expect(version1, startsWith('1.0.0-test.'));
      expect(screen1, contains('v$version1'), reason: 'the result shows the version the service journalled');
      final key = jsonDecode(keyFile.readAsStringSync()) as Map;
      expect(screen1, contains(key['keyId'] as String), reason: 'the public key id is shown');
      expect(screen1, contains('payload SHA-256'));
      expect(screen1, contains('运行时 ABI'));
      final history1 = (published['history'] as List).cast<Map>();
      expect(history1, hasLength(1));
      expect(screen1, contains('${history1.single['payloadSha256']}'.substring(0, 20)), reason: 'payload digest on screen');

      // Copy: tapping the first 复制 (the key id) puts it on the real (test-bound) system clipboard.
      clipboardText = 'before';
      await tap('复制');
      await until(() => textOf().contains('已复制'), 'copy toast');
      expect(clipboardText, key['keyId']);

      // ---- Versions page shows the new entry ---------------------------------------------------------------
      await tap('版本');
      await until(() => textOf().contains('v$version1 · 构建 $build1 · 当前'), 'the new version entry');
      expect(textOf(), contains('测试槽（test）'));
      expect(textOf(), contains('试用 / 已提升 / 已回滚'));

      // ---- A client activates the published test slot through the SDK update path ------------------------
      final appConfigUrl = published['appConfigUrl'] as String;
      expect(appConfigUrl, contains('/test/pocket/'));
      final hostConfig = await PocketHostConfig.load(
        Uri.parse(appConfigUrl),
        allowInsecureHttpHosts: const <String>{'127.0.0.1'},
        trustAnchorDirectory: support,
      );
      // The client host: ships build 1 (BASELINE_V0) and updates from the service's test slot.
      final updates = hostConfig.systemUI.updates!;
      expect(updates.manifestUri('pocket.pub').toString(), contains('/test/pocket/'));
      final coordinator = PocketUpdateCoordinator(
        manifestUri: updates.manifestUri('pocket.pub'),
        appId: 'pocket.pub',
        trustedKeys: <String, List<int>>{updates.keyId: base64Decode(updates.publicKey)},
        store: PocketPackageStore(Directory('${support.path}/client-packages/pocket.pub/${updates.namespace}')),
        expectedRuntimeAbi: metadata['runtimeAbi'] as String,
        requireBytecode: true,
        minimumBuild: 1,
        debugHttpHosts: const <String>['127.0.0.1'],
      );
      addTearDown(coordinator.dispose);
      expect(updates.keyId, key['keyId'], reason: 'the client trusts exactly the key the Studio displayed');

      // Before the update the client runs the shipped build.
      var baselineRuntime = FfiPocketRuntime.open(width: 360, height: 640);
      expect(syncPocketHostFonts(baselineRuntime), isTrue);
      var bframe = baselineRuntime.loadBytecode(
        Uint8List.fromList(File('${baselineDir.path}/app.qjbc').readAsBytesSync()),
        Uint8List.fromList(File('${baselineDir.path}/app.pak').readAsBytesSync()),
        expectedRuntimeAbi: metadata['runtimeAbi'] as String,
      );
      for (var i = 0; i < 80 && !bframe.ops.whereType<PocketTextOp>().any((o) => o.text.contains('BASELINE_V0')); i++) {
        bframe = baselineRuntime.frame(16);
      }
      expect(bframe.ops.whereType<PocketTextOp>().map((o) => o.text), contains('BASELINE_V0 count 0'));
      baselineRuntime.dispose();

      final prepared1 = await coordinator.prepare(mode: PocketUpdateMode.granular);
      expect(prepared1.version, version1);
      expect(prepared1.build, build1);
      expect(build1, greaterThan(1));
      await coordinator.activate(prepared1);
      expect(prepared1.downloadedFiles, greaterThan(0), reason: 'the client downloaded blobs and verified every hash');
      final active1 = prepared1;

      clientRuntime = FfiPocketRuntime.open(width: 360, height: 640);
      expect(syncPocketHostFonts(clientRuntime), isTrue);
      var cframe = clientRuntime.loadBytecode(
        Uint8List.fromList(await File(active1.source.entryPath).readAsBytes()),
        Uint8List.fromList(await File(active1.source.pakPath).readAsBytes()),
        expectedRuntimeAbi: metadata['runtimeAbi'] as String,
      );
      String ctext() => cframe.ops.whereType<PocketTextOp>().map((o) => o.text).join('\n');
      for (var i = 0; i < 80 && !ctext().contains('PUBLISHED_V1'); i++) {
        cframe = clientRuntime.frame(16);
      }
      expect(ctext(), contains('PUBLISHED_V1 count 0'), reason: 'the downloaded guest runs and draws its output');
      final button = cframe.ops.whereType<PocketTextOp>().singleWhere((o) => o.text == 'Increment');
      final point = {'id': 0, 'x': button.x + button.width / 2, 'y': button.y + button.height / 2};
      clientRuntime.send({'type': 'event', 'name': 'input.pointer', 'payload': {...point, 'phase': 'down'}});
      clientRuntime.frame(16);
      clientRuntime.send({'type': 'event', 'name': 'input.pointer', 'payload': {...point, 'phase': 'up'}});
      cframe = clientRuntime.frame(16);
      expect(ctext(), contains('PUBLISHED_V1 count 1'), reason: 'input changes the downloaded guest frame');
      clientRuntime.dispose();
      clientRuntime = null;

      // ---- Second publish: change the source (as an external editor would), rebuild and publish by taps ----
      await writer.invoke('studio.fs.write', {'project': 'pub-app', 'path': 'app.tsx', 'content': _source('PUBLISHED_V2')});
      await writer.dispose();
      await buildViaStudio();
      await tap('发布');
      await until(() => textOf().contains('已构建（可发布）') && textOf().contains('v$version1'), 'plan after the second build');
      await tap('发布测试包');
      await until(() => textOf().contains('发布完成 · 测试') && !textOf().contains('发布中…'), 'the second publish');
      final published2 = await _getJson(config.port, '/api/projects/pub-app/versions');
      final slot2 = (published2['slots'] as List).cast<Map>().firstWhere((s) => s['name'] == 'test');
      final version2 = slot2['version'] as String;
      expect(version2, isNot(version1));
      expect(slot2['build'] as int, greaterThan(build1));
      expect((published2['history'] as List), hasLength(2));
      await tap('版本');
      await until(() => textOf().contains('v$version2 · 构建 ${slot2['build']} · 当前') && textOf().contains('v$version1 · 构建 $build1'), 'two entries on the versions page');

      // The same client picks up the new signed build: download only what changed, verify, activate, run.
      final prepared2 = await coordinator.prepare();
      expect(prepared2.version, version2);
      expect(prepared2.build, slot2['build']);
      expect(prepared2.reusedFiles, greaterThan(0), reason: 'unchanged blobs of the active package are reused, not downloaded again');
      await coordinator.activate(prepared2);
      final active2 = prepared2;
      clientRuntime = FfiPocketRuntime.open(width: 360, height: 640);
      expect(syncPocketHostFonts(clientRuntime), isTrue);
      cframe = clientRuntime.loadBytecode(
        Uint8List.fromList(await File(active2.source.entryPath).readAsBytes()),
        Uint8List.fromList(await File(active2.source.pakPath).readAsBytes()),
        expectedRuntimeAbi: metadata['runtimeAbi'] as String,
      );
      for (var i = 0; i < 80 && !ctext().contains('PUBLISHED_V2'); i++) {
        cframe = clientRuntime.frame(16);
      }
      expect(ctext(), contains('PUBLISHED_V2 count 0'), reason: 'the client now runs the update');

      // ---- Keys stay in the service ------------------------------------------------------------------------
      final secrets = <String>[
        for (final entry in key.entries)
          if (!const {'keyId', 'publicKeyBase64', 'algorithm', 'createdAt'}.contains(entry.key) && entry.value is String && (entry.value as String).length >= 16) entry.value as String,
      ];
      expect(secrets, isNotEmpty, reason: 'the key file holds private material (fields: ${key.keys})');
      final everything = toGuest.join('\n');
      for (final secret in secrets) {
        expect(everything, isNot(contains(secret)), reason: 'no private key material may reach the guest');
        expect(textOf(), isNot(contains(secret)));
      }
      expect(everything, isNot(contains('PRIVATE KEY')));
      expect(everything, isNot(contains(work.path)), reason: 'no absolute workspace path reached the guest');
    } finally {
      clientRuntime?.dispose();
      await manager.dispose();
      runtime.dispose();
    }
  }, skip: skip != false, timeout: const Timeout(Duration(minutes: 10)));
}


Future<Map<String, dynamic>> _getJson(int port, String path) async {
  final client = HttpClient();
  try {
    final request = await client.getUrl(Uri.parse('http://127.0.0.1:$port$path'));
    final response = await request.close();
    final body = await utf8.decodeStream(response);
    if (response.statusCode != 200) throw StateError('GET $path -> ${response.statusCode} $body');
    return jsonDecode(body) as Map<String, dynamic>;
  } finally {
    client.close(force: true);
  }
}

String _source(String marker) => '''
import { createSignal } from "solid-js";
import { mount } from "@pocketjs/framework/solid";
import { Focusable, Screen, Text, View } from "@pocketjs/framework/solid/components";

const [count, setCount] = createSignal(0);

mount(() => <Screen class="w-full h-full flex-col bg-white">
  <View class="flex-col gap-2 p-4">
    <Text class="text-base text-black">{`$marker count \${count()}`}</Text>
    <Focusable class="p-2 bg-black rounded-lg" onPress={() => setCount(count() + 1)}>
      <Text class="text-base text-white">Increment</Text>
    </Focusable>
  </View>
</Screen>);
''';
