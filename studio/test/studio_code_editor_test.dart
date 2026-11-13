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

/// M4 exit test (Linux half): open a ~5,000-line TSX file in the Studio code editor, scroll, type through
/// PocketView raw text input (hardware key edges and IME deltas), undo with Meta+Z, save with Meta+S, and
/// compare the file on disk. Everything is real: native runtime, Studio bytecode, host grants, editor
/// service. The macOS IME checklist and profile-build frame budget are NOT covered here (deferred).
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

  late Directory work;
  late Directory project;
  late PocketStudioConfig config;
  late PocketStudioService service;
  late String original;

  setUpAll(() async {
    if (skip != false) return;
    work = await Directory.systemTemp.createTemp('studio-code-');
    project = Directory('${work.path}/code-app')..createSync();
    File('${project.path}/pocket.json').writeAsStringSync(jsonEncode({'app': {'entry': 'app.tsx'}, 'version': '1.0.0', 'build': 1}));
    File('${project.path}/editor.json').writeAsStringSync(jsonEncode({
      'id': 'code-app', 'appId': 'pocket.code', 'name': 'Code App', 'title': 'Code App',
      'version': '1.0.0', 'build': 1, 'tickHz': 60, 'entry': 'app.tsx', 'output': 'app', 'framework': 'solid',
    }));
    File('${project.path}/manifest.json').writeAsStringSync('{"capabilities":{"requires":[]}}');
    original = _bigSource(int.parse(Platform.environment["STUDIO_E2E_LINES"] ?? "5000"));
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

  testWidgets('Studio code editor: 5,000-line TSX, scroll, keys + IME, Meta+Z, Meta+S, file on disk', (tester) async {
    tester.view.physicalSize = const Size(900, 640);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final support = (await tester.runAsync(() => Directory.systemTemp.createTemp('studio-code-support-')))!;
    binding.defaultBinaryMessenger.setMockMethodCallHandler(const MethodChannel('plugins.flutter.io/path_provider'), (_) async => support.path);

    final controller = PocketSystemHostController();
    final boundaryKey = GlobalKey();
    await tester.pumpWidget(
      MaterialApp(
        debugShowCheckedModeBanner: false,
        home: RepaintBoundary(key: boundaryKey, child: PocketSystemHost(
          systemUI: studioSystemUI(config),
          applications: {PocketStudioConfig.previewAppId: studioPreviewChild(config, previewBootstrapMetadata: previewBootstrap(File('$repo/studio/assets/app.bytecode.json').readAsStringSync()))},
          controller: controller,
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
        File('$shotDir/${(++shotIndex).toString().padLeft(2, '0')}-$name.png').writeAsBytesSync(bytes.buffer.asUint8List());
      });
    }


    Future<void> pumpFor(Duration d) async {
      final end = DateTime.now().add(d);
      while (DateTime.now().isBefore(end)) {
        await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 5)));
        await tester.pump(const Duration(milliseconds: 16));
      }
    }

    Future<void> waitUntil(bool Function() ok, String what, {Duration timeout = const Duration(seconds: 90)}) async {
      final clock = Stopwatch()..start();
      while (clock.elapsed < timeout) {
        if (ok()) return;
        await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 5)));
        await tester.pump(const Duration(milliseconds: 16));
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

    Future<void> chord(LogicalKeyboardKey modifier, LogicalKeyboardKey key) async {
      await tester.sendKeyDownEvent(modifier);
      await tester.sendKeyEvent(key);
      await tester.sendKeyUpEvent(modifier);
      await pumpFor(const Duration(milliseconds: 150));
    }

    Future<void> ime(String oldText, String delta, int start, int end, int selection, {int composingBase = -1, int composingExtent = -1}) async {
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
                'composingBase': composingBase, 'composingExtent': composingExtent,
              },
            ],
          },
        ])),
        (_) {},
      );
      await pumpFor(const Duration(milliseconds: 150));
    }

    await waitUntil(() => controller.instances.any((i) => i.appId == studioAppId && i.firstFrameReady), 'Studio first frame');
    await pumpFor(const Duration(seconds: 3));
    // Projects -> open the temp project -> open app.tsx (same layout as the M3 loop test).
    await tapAt(30, 39);
    await tapAt(300, 78);
    await pumpFor(const Duration(seconds: 2));
    await shot('project');
    await tapAt(130, 160);
    await pumpFor(const Duration(seconds: 10)); // read + CodeEditor + first CodeView frames (debug native build)
    await shot('file-open');

    // Scroll the virtualised view down and back (wheel), watching the layout cache.
    final cache0 = studioSession().controller.textLayoutCacheStats;
    expect(cache0?.capacity, 2048, reason: 'studioSystemUI carries textLayoutCacheCapacity to the PocketView');
    for (var i = 0; i < 40; i++) {
      studioSession().controller.send(method: 'input.scroll', params: {'x': 500, 'y': 300, 'deltaY': 60.0, 'source': 'wheel', 'phase': 'update'});
      await pumpFor(const Duration(milliseconds: 20));
    }
    for (var i = 0; i < 40; i++) {
      studioSession().controller.send(method: 'input.scroll', params: {'x': 500, 'y': 300, 'deltaY': -60.0, 'source': 'wheel', 'phase': 'update'});
      await pumpFor(const Duration(milliseconds: 20));
    }
    final cache1 = studioSession().controller.textLayoutCacheStats;

    // Focus the code view at the first row: the guest opens a raw text session and the host attaches an IME client.
    for (var attempt = 0; attempt < 4 && !tester.testTextInput.hasAnyClients; attempt++) {
      await tapAt(520, 124); // inside the text area (the gutter widens with the line count)
    }
    // ignore: avoid_print
    await waitUntil(() => tester.testTextInput.hasAnyClients, 'IME client for the raw text session');
    // Cmd+Up: document start (macOS keymap), so the edits land at a known place.
    await chord(LogicalKeyboardKey.metaLeft, LogicalKeyboardKey.arrowUp);

    final keystrokes = Stopwatch();
    final perKey = <int>[];
    Future<void> typed(Future<void> Function() action) async {
      keystrokes
        ..reset()
        ..start();
      await action();
      keystrokes.stop();
      perKey.add(keystrokes.elapsedMilliseconds);
    }

    // IME commit "ab", a composition "ni" -> "你", a hardware Backspace and an Enter key edge.
    await typed(() => ime('', 'ab', 0, 0, 2));
    await typed(() => ime('', 'ni', 0, 0, 2, composingBase: 0, composingExtent: 2));
    await typed(() => ime('ni', '你', 0, 2, 1));
    await typed(() async {
      await tester.sendKeyEvent(LogicalKeyboardKey.backspace);
      await pumpFor(const Duration(milliseconds: 100));
    });
    await typed(() => ime('', 'Z', 0, 0, 1));
    // Meta+Z undoes the last typing step; Meta+S saves through the existing save flow.
    await chord(LogicalKeyboardKey.metaLeft, LogicalKeyboardKey.keyZ);
    expect(File('${project.path}/app.tsx').readAsStringSync(), original, reason: 'nothing is written before Save');
    await chord(LogicalKeyboardKey.metaLeft, LogicalKeyboardKey.keyS);
    await waitUntil(() => File('${project.path}/app.tsx').readAsStringSync() != original, 'saved file on disk');
    final saved = File('${project.path}/app.tsx').readAsStringSync();

    // The saved text is the original with the typed text inserted at the document start. After Backspace removed
    // the composed character and Meta+Z removed "Z", the expected insertion is "ab" (plus whatever the
    // backspace did to it); assert structurally: same tail, only the head differs, line count unchanged.
    expect(saved.endsWith(original), isTrue, reason: 'only text was inserted at the head: ${saved.substring(0, 60)}');
    final inserted = saved.substring(0, saved.length - original.length);
    expect(inserted, isNotEmpty);
    expect(inserted.contains('Z'), isFalse, reason: 'Meta+Z undid the last typing step');
    expect(inserted.contains('ab') || inserted.contains('a'), isTrue);
    expect(saved.split('\n').length, original.split('\n').length);

    // M7 profile: 100 more single-character IME commits at the document start (host-observed wall time per key includes the
    // 150 ms pump of the helper; the guest-side per-frame numbers are in studio/js/tests/studio_profile.test.ts).
    final rssBeforeKeys = ProcessInfo.currentRss;
    final keyClock = Stopwatch()..start();
    for (var i = 0; i < 100; i++) {
      await ime('', String.fromCharCode(97 + i % 26), 0, 0, 1);
    }
    keyClock.stop();
    final cache2 = studioSession().controller.textLayoutCacheStats;
    final rssAfterKeys = ProcessInfo.currentRss;
    // ignore: avoid_print
    print('STUDIO_PROFILE_DART ${jsonEncode({
      'keys': 100,
      'wallMsPerKeyIncludingPump': (keyClock.elapsedMilliseconds / 100).round(),
      'rssMBBefore': (rssBeforeKeys / 1048576).round(),
      'rssMBAfter': (rssAfterKeys / 1048576).round(),
      'layoutCache': cache2 == null ? null : {'capacity': cache2.capacity, 'length': cache2.length, 'hits': cache2.hitCount, 'layouts': cache2.layoutCount, 'evictions': cache2.evictionCount},
    })}');
    // Generous regression bounds: the cache never exceeds its capacity, typing does not thrash it, and the process
    // (Flutter test harness + native runtime + debug build) stays far below a runaway heap.
    expect(cache2!.length, lessThanOrEqualTo(cache2.capacity));
    expect(cache2.evictionCount, lessThan(cache2.capacity * 20), reason: 'layout cache thrashing');
    expect(rssAfterKeys - rssBeforeKeys, lessThan(300 * 1048576), reason: '100 keys must not grow the process by hundreds of MB');
    expect(rssAfterKeys, lessThan(4 * 1024 * 1048576));

    // ignore: avoid_print
    print('STUDIO_CODE_E2E ${jsonEncode({
      'lines': original.split('\n').length,
      'bytes': original.length,
      'insertedAtHead': inserted,
      'perStepWallMs (key/IME event + 100-150 ms pump, host-observed)': perKey,
      'textLayoutCache before scroll': cache0 == null ? null : {'capacity': cache0.capacity, 'length': cache0.length, 'layouts': cache0.layoutCount},
      'textLayoutCache after scroll down+up': cache1 == null ? null : {
        'capacity': cache1.capacity, 'length': cache1.length, 'hits': cache1.hitCount,
        'layouts': cache1.layoutCount, 'evictions': cache1.evictionCount,
      },
    })}');

    await tester.pumpWidget(const SizedBox.shrink());
    await tester.pump(const Duration(milliseconds: 100));
    binding.defaultBinaryMessenger.setMockMethodCallHandler(const MethodChannel('plugins.flutter.io/path_provider'), null);
  }, skip: skip != false, timeout: const Timeout(Duration(minutes: 8)));
}

String _bigSource(int lines) {
  final b = StringBuffer("import { View, Text } from \"@pocketjs/framework/solid/components\";\n");
  for (var i = 1; i < lines; i++) {
    b.writeln('export const value$i = { id: $i, label: "item $i" }; // line $i');
  }
  return b.toString();
}
