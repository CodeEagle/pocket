import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pocket_sdk/pocket_sdk.dart';
import 'package:pocket_studio/pocket_studio.dart';
import 'package:pocket_studio_app/main.dart';

/// M7 record-and-replay UI regression (Linux part). The SDK's own recording facility is used end to end:
/// `PocketRecordingLibrary` (native clock/frame/host-transaction lanes) is attached to the Studio's SystemUI,
/// a real user journey runs against the real Studio guest, the real editor service and a TEMP project
///
///     open project -> open file -> edit (IME commit) -> save (Cmd+S) -> build (Cmd+B) -> publish page (Cmd+Shift+P)
///     -> publish a signed test update (tap)
///
/// then the capture is stopped and
///  1. replayed in fresh native guests (no service, no providers: every host.response, clock value and input comes
///     from the tape) and every recorded frame digest must match (`matched`, `framesCompared > 0`, no `firstMismatch`),
///  2. exported to an archive and replayed again from disk (tamper-evident content-addressed assets).
///
/// Why not a stored tape fixture: the tape pins the exact bytecode of the Studio build (content hashes, engine ABI).
/// Every Studio source change would invalidate it, so a stored tape would test the old guest, not the current one.
/// The suite therefore re-records every run against the current build; what is STORED is the normalised semantic
/// checkpoint list in `fixtures/journey_checkpoints.json`. Service timestamps, build ids, hashes, ports and temp
/// paths are normalised away (only structural facts remain), so the fixture is deterministic across runs and
/// machines and fails when a UI change alters what the journey achieves. Regenerate with STUDIO_UPDATE_FIXTURES=1.
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
  late String original;

  setUpAll(() async {
    if (skip != false) return;
    work = await Directory.systemTemp.createTemp('studio-record-');
    project = Directory('${work.path}/rec-app')..createSync();
    File('${project.path}/pocket.json').writeAsStringSync(jsonEncode({'app': {'entry': 'app.tsx'}, 'version': '1.0.0', 'build': 1}));
    File('${project.path}/editor.json').writeAsStringSync(jsonEncode({
      'id': 'rec-app', 'appId': 'pocket.rec', 'name': 'Rec App', 'title': 'Rec App',
      'version': '1.0.0', 'build': 1, 'tickHz': 60, 'entry': 'app.tsx', 'output': 'app', 'framework': 'solid',
    }));
    File('${project.path}/manifest.json').writeAsStringSync('{"capabilities":{"requires":[]}}');
    original = _source();
    File('${project.path}/app.tsx').writeAsStringSync(original);
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

  testWidgets('record open, edit, build and publish; replay offline; replay the exported archive; checkpoints match the fixture', (tester) async {
    tester.view.physicalSize = const Size(900, 700);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final support = (await tester.runAsync(() => Directory.systemTemp.createTemp('studio-record-support-')))!;
    final messenger = binding.defaultBinaryMessenger;
    messenger.setMockMethodCallHandler(const MethodChannel('plugins.flutter.io/path_provider'), (_) async => support.path);
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
    addTearDown(() {
      messenger.setMockMethodCallHandler(SystemChannels.platform, null);
      messenger.setMockMethodCallHandler(const MethodChannel('plugins.flutter.io/path_provider'), null);
    });

    // The library is recording from the very first transaction of the Studio runtime (recordOnStart).
    final recordings = PocketRecordingLibrary(recordOnStart: true);
    final controller = PocketSystemHostController();
    final boundaryKey = GlobalKey();
    await tester.pumpWidget(
      MaterialApp(
        debugShowCheckedModeBanner: false,
        home: RepaintBoundary(key: boundaryKey, child: PocketSystemHost(
          systemUI: studioSystemUI(config),
          applications: {PocketStudioConfig.previewAppId: studioPreviewChild(config, previewBootstrapMetadata: previewBootstrap(File('$repo/studio/assets/app.bytecode.json').readAsStringSync()))},
          controller: controller,
          recordings: recordings,
        )),
      ),
    );
    final shotDir = Platform.environment['STUDIO_SHOT_DIR'];
    var shotIndex = 0;
    Future<void> shot(String name) async {
      if (shotDir == null) return;
      await tester.runAsync(() async {
        final boundary = boundaryKey.currentContext!.findRenderObject() as RenderRepaintBoundary;
        final image = await boundary.toImage();
        final bytes = (await image.toByteData(format: ui.ImageByteFormat.png))!;
        Directory(shotDir).createSync(recursive: true);
        File('$shotDir/rec-${(++shotIndex).toString().padLeft(2, '0')}-$name.png').writeAsBytesSync(bytes.buffer.asUint8List());
      });
    }

    Future<void> pumpFor(Duration d) async {
      final end = DateTime.now().add(d);
      while (DateTime.now().isBefore(end)) {
        await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 5)));
        await tester.pump(const Duration(milliseconds: 16));
      }
    }

    Future<void> waitUntil(FutureOr<bool> Function() ok, String what, {Duration timeout = const Duration(seconds: 120)}) async {
      final clock = Stopwatch()..start();
      while (clock.elapsed < timeout) {
        final done = await tester.runAsync(() async => await ok());
        if (done == true) return;
        await tester.pump(const Duration(milliseconds: 16));
        await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 20)));
      }
      fail('timed out waiting for $what');
    }

    PocketSession studioSession() => controller.instances.firstWhere((i) => i.appId == studioAppId).session;
    Future<void> tapAt(double x, double y) async {
      for (final phase in const ['down', 'up']) {
        studioSession().controller.send(method: 'input.pointer', params: {'phase': phase, 'id': 0, 'x': x, 'y': y});
        await pumpFor(const Duration(milliseconds: 80));
      }
      await pumpFor(const Duration(milliseconds: 200));
    }

    Future<void> chord(List<LogicalKeyboardKey> modifiers, LogicalKeyboardKey key) async {
      for (final m in modifiers) {
        await tester.sendKeyDownEvent(m);
      }
      await tester.sendKeyEvent(key);
      for (final m in modifiers.reversed) {
        await tester.sendKeyUpEvent(m);
      }
      await pumpFor(const Duration(milliseconds: 150));
    }

    Future<void> ime(String oldText, String delta, int start, int end, int selection) async {
      final setClient = tester.testTextInput.log.lastWhere((c) => c.method == 'TextInput.setClient');
      final clientId = (setClient.arguments as List<dynamic>)[0] as int;
      await tester.binding.defaultBinaryMessenger.handlePlatformMessage(
        'flutter/textinput',
        const JSONMethodCodec().encodeMethodCall(MethodCall('TextInputClient.updateEditingStateWithDeltas', <dynamic>[
          clientId,
          <String, dynamic>{
            'deltas': [
              {
                'oldText': oldText, 'deltaText': delta, 'deltaStart': start, 'deltaEnd': end,
                'selectionBase': selection, 'selectionExtent': selection,
                'selectionAffinity': 'TextAffinity.downstream', 'selectionIsDirectional': false,
                'composingBase': -1, 'composingExtent': -1,
              },
            ],
          },
        ])),
        (_) {},
      );
      await pumpFor(const Duration(milliseconds: 150));
    }

    // ------------------------------------------------------------------ the journey, with semantic checkpoints
    final checkpoints = <String, Object?>{};
    // Real HTTP must run outside the test's fake-async zone.
    Future<Map<String, dynamic>> status() async => (await tester.runAsync(() => _getJson(config.port, '/api/projects/rec-app/status')))!;
    Future<Map<String, dynamic>> versions() async => (await tester.runAsync(() => _getJson(config.port, '/api/projects/rec-app/versions')))!;
    Future<Map<String, dynamic>> filesList() async => (await tester.runAsync(() => _getJson(config.port, '/api/projects/rec-app/files')))!;

    await waitUntil(() => controller.instances.any((i) => i.appId == studioAppId && i.firstFrameReady), 'Studio first frame');
    await pumpFor(const Duration(seconds: 3));
    await shot('start');

    // 1. open: Projects -> the temp project -> its file tree.
    await tapAt(30, 39);
    await tapAt(300, 78);
    await waitUntil(() async => (await _getJson(config.port, '/api/projects/rec-app/status'))['id'] == 'rec-app', 'project status');
    await pumpFor(const Duration(seconds: 2));
    await shot('project-open');
    await tapAt(130, 160); // app.tsx, first file row
    await pumpFor(const Duration(seconds: 6));
    await shot('file-open');
    checkpoints['open'] = {
      'projectFiles': (await filesList())['files'].map((f) => (f as Map)['path']).toList()..sort(),
      'fileOnDiskUnchanged': File('${project.path}/app.tsx').readAsStringSync() == original,
    };

    // 2. edit: focus the code view (raw text session), jump to the document start, commit "ab" through the IME channel.
    for (var attempt = 0; attempt < 4 && !tester.testTextInput.hasAnyClients; attempt++) {
      await tapAt(520, 124);
    }
    await waitUntil(() => tester.testTextInput.hasAnyClients, 'IME client for the raw text session');
    await chord([LogicalKeyboardKey.metaLeft], LogicalKeyboardKey.arrowUp);
    await ime('', '/*ab*/', 0, 0, 6); // a valid block comment: the saved source must still build
    checkpoints['edit'] = {'diskStillOriginalBeforeSave': File('${project.path}/app.tsx').readAsStringSync() == original};

    // 3. save: Cmd+S is the CodeView's save intent.
    await chord([LogicalKeyboardKey.metaLeft], LogicalKeyboardKey.keyS);
    await waitUntil(() => File('${project.path}/app.tsx').readAsStringSync() != original, 'saved file on disk');
    final saved = File('${project.path}/app.tsx').readAsStringSync();
    checkpoints['save'] = {'insertedAtHead': saved.substring(0, saved.length - original.length), 'tailUnchanged': saved.endsWith(original)};
    await shot('saved');

    // 4. build: Cmd+B is a global shell key (it wins although the editor owns the keyboard).
    await chord([LogicalKeyboardKey.metaLeft], LogicalKeyboardKey.keyB);
    await waitUntil(() async {
      final s = await _getJson(config.port, '/api/projects/rec-app/status');
      return s['busy'] == false && s['builtRevision'] == s['revision'] && s['error'] == null;
    }, 'the service to finish the build', timeout: const Duration(seconds: 180));
    final built = await status();
    checkpoints['build'] = {'builtCurrentRevision': built['builtRevision'] == built['revision'], 'error': built['error']};
    await shot('built');

    // 5. publish: Cmd+Shift+P opens the Publish page, a tap on 发布测试包 signs a test update.
    await chord([LogicalKeyboardKey.metaLeft, LogicalKeyboardKey.shiftLeft], LogicalKeyboardKey.keyP);
    await pumpFor(const Duration(seconds: 2));
    await shot('publish-page');
    await tapAt(_publishButtonX, _publishButtonY);
    await waitUntil(() async => ((await _getJson(config.port, '/api/projects/rec-app/versions'))['history'] as List).isNotEmpty, 'a published release in the journal', timeout: const Duration(seconds: 120));
    await pumpFor(const Duration(seconds: 2));
    await shot('published');
    final history = (await versions())['history'] as List;
    final first = history.first as Map;
    checkpoints['publish'] = {
      'releases': history.length,
      'slot': first['slot'],
      'channel': first['channel'],
      'packageIds': (first['packages'] as List).map((p) => (p as Map)['id']).toList(),
      'hasPayloadDigest': RegExp(r'^[0-9a-f]{64}$').hasMatch('${first['payloadSha256']}'),
    };

    // ------------------------------------------------------------------ freeze, replay offline, export, replay the archive
    final status0 = recordings.status();
    expect(status0['incomplete'], isNot(true), reason: 'capture must be complete: ${status0['reason']}');
    recordings.stop();
    final stopped = recordings.status();
    expect(stopped['incomplete'], isNot(true), reason: '${stopped['reason']}');
    final studioRuntime = (stopped['runtimes'] as List).cast<Map>().firstWhere((r) => r['appId'] == studioAppId);
    checkpoints['recording'] = {
      'complete': true,
      'studioGuestFinished': studioRuntime['finished'] == true,
      'hasTransactions': (studioRuntime['entries'] as int) > 100,
    };

    final replayed = (await tester.runAsync(() => recordings.replay()))!;
    // ignore: avoid_print
    print('STUDIO_RECORDING_REPLAY ${jsonEncode(_summary(replayed))}');
    expect(replayed['ok'], isTrue, reason: 'offline replay of the recorded journey must match every frame: ${jsonEncode(_summary(replayed))}');
    for (final r in _runtimes(replayed)) {
      expect(r['matched'], isTrue);
      expect(r['replayable'], isTrue);
      expect(r['firstMismatch'], isNull);
    }
    expect(_sum(replayed, 'framesCompared'), greaterThan(50), reason: 'a real journey compares many frame digests');
    expect(_sum(replayed, 'entriesReplayed'), greaterThan(100));

    final exported = (await tester.runAsync(() => recordings.export(directory: Directory('${work.path}/archive'))))!;
    final archive = File(exported['path'] as String);
    expect(archive.existsSync(), isTrue);
    final again = (await tester.runAsync(() => PocketRecordingLibrary.replayArchive(archive)))!;
    expect(again['ok'], isTrue, reason: 'the exported archive replays from disk: ${jsonEncode(_summary(again))}');
    expect(_sum(again, 'framesCompared'), _sum(replayed, 'framesCompared'));
    // Nothing the guest ever received (the tape holds every host.response) contains key material or an absolute path.
    final tape = File(exported['path'] as String).readAsStringSync();
    final key = jsonDecode(File('${work.path}/ws/keys/editor-dev-key.json').readAsStringSync()) as Map<String, dynamic>;
    final secrets = [for (final e in key.entries) if (e.value is String && (e.value as String).length >= 24 && RegExp('private|secret', caseSensitive: false).hasMatch(e.key)) e.value as String];
    expect(secrets, isNotEmpty, reason: 'the key file has a private field to look for');
    for (final secret in secrets) {
      expect(tape.contains(secret), isFalse, reason: 'private key material must never reach the guest');
    }
    expect(tape.contains(work.path), isFalse, reason: 'absolute workspace paths must never reach the guest');
    checkpoints['privacy'] = {'noPrivateKeyInTape': true, 'noAbsolutePathInTape': true};
    checkpoints['replay'] = {'matched': true, 'archiveMatched': true, 'firstMismatch': null};

    // ------------------------------------------------------------------ semantic checkpoints against the stored fixture
    final actual = const JsonEncoder.withIndent('  ').convert(checkpoints);
    final fixture = File('$repo/studio/test/fixtures/journey_checkpoints.json');
    if (Platform.environment['STUDIO_UPDATE_FIXTURES'] == '1' || !fixture.existsSync()) {
      fixture.writeAsStringSync('$actual\n');
    }
    expect(jsonDecode(actual), jsonDecode(fixture.readAsStringSync()), reason: 'journey checkpoints drifted from test/fixtures/journey_checkpoints.json (STUDIO_UPDATE_FIXTURES=1 regenerates after review)');

    await tester.pumpWidget(const SizedBox.shrink());
    await tester.pump(const Duration(milliseconds: 100));
  }, skip: skip != false, timeout: const Timeout(Duration(minutes: 12)));
}

// Publish-page button, in the 900x700 window (found with STUDIO_SHOT_DIR screenshots).
const double _publishButtonX = 855;
const double _publishButtonY = 79;

Iterable<Map> _runtimes(Map<String, dynamic> result) => (result['runtimes'] as Map).values.cast<Map>();

int _sum(Map<String, dynamic> result, String key) => _runtimes(result).fold<int>(0, (total, r) => total + ((r[key] as num?)?.toInt() ?? 0));

Map<String, Object?> _summary(Map<String, dynamic> result) => {
  'ok': result['ok'],
  'runtimes': {
    for (final e in (result['runtimes'] as Map).entries)
      '${e.key}': {for (final k in const ['matched', 'replayable', 'entriesReplayed', 'framesCompared', 'firstMismatch']) k: (e.value as Map)[k]},
  },
};

Future<Map<String, dynamic>> _getJson(int port, String path) async {
  final client = HttpClient();
  try {
    final request = await client.getUrl(Uri.parse('http://127.0.0.1:$port$path'));
    final response = await request.close();
    final body = await response.transform(utf8.decoder).join();
    return jsonDecode(body) as Map<String, dynamic>;
  } finally {
    client.close(force: true);
  }
}

String _source() {
  final b = StringBuffer('import { View, Text } from "@pocketjs/framework/solid/components";\n');
  for (var i = 1; i < 40; i++) {
    b.writeln('export const value$i = { id: $i, label: "item $i" }; // line $i');
  }
  b.writeln('export default function App() { return <View><Text>RECORDED_APP</Text></View>; }');
  return b.toString();
}
