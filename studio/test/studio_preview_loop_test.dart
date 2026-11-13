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

/// M3 exit test: "save a file and see the running preview update with no manual step".
///
/// Everything is real: the native QuickJS runtime, the Studio bytecode, the host's own
/// `studioSystemUI` / `studioPreviewChild` configuration, `PocketStudioPlugin`, a real editor service
/// (pinned compiler, real signing) started by `PocketStudioService` on a TEMP project, and the signed
/// preview child downloaded through the normal update coordinator. The Studio guest is driven only by
/// input events (pointer taps, the Flutter text overlay) and its own auto-build setting; the test never
/// calls a studio.* capability. Observed facts: the file on disk, the service build state, the
/// preview child's session (active build) and its frame digests.
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
  final shotDir = Platform.environment['STUDIO_SHOT_DIR'];

  late Directory work;
  late Directory project;
  late PocketStudioConfig config;
  late PocketStudioService service;

  setUpAll(() async {
    if (skip != false) return;
    work = await Directory.systemTemp.createTemp('studio-loop-');
    project = Directory('${work.path}/loop-app')..createSync();
    File('${project.path}/pocket.json').writeAsStringSync(jsonEncode({'app': {'entry': 'app.tsx'}, 'version': '1.0.0', 'build': 1}));
    File('${project.path}/editor.json').writeAsStringSync(jsonEncode({
      'id': 'loop-app', 'appId': 'pocket.loop', 'name': 'Loop App', 'title': 'Loop App',
      'version': '1.0.0', 'build': 1, 'tickHz': 60, 'entry': 'app.tsx', 'output': 'app', 'framework': 'solid',
    }));
    File('${project.path}/manifest.json').writeAsStringSync('{"capabilities":{"requires":[]}}');
    File('${project.path}/app.tsx').writeAsStringSync(_source('PREVIEW_V0'));
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

  testWidgets('save in Studio with auto-build on updates the running preview with no further input', (tester) async {
    // The service creates the preview signing key at startup: the child is fully configured before any publish.
    expect(config.readPreviewKey(), isNotNull, reason: 'preview key must exist right after the service starts');

    tester.view.physicalSize = const Size(900, 640);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final support = (await tester.runAsync(() => Directory.systemTemp.createTemp('studio-loop-support-')))!;
    binding.defaultBinaryMessenger.setMockMethodCallHandler(const MethodChannel('plugins.flutter.io/path_provider'), (_) async => support.path);

    final studioMetadata = File('$repo/studio/assets/app.bytecode.json').readAsStringSync();
    final childRecordings = <PocketRecordingController>[];
    final controller = PocketSystemHostController();
    final child = studioPreviewChild(config, previewBootstrapMetadata: previewBootstrap(studioMetadata)).copyWith(
      recordingFactory: () {
        final recording = PocketRecordingController();
        childRecordings.add(recording);
        return recording;
      },
    );
    expect(child.downloadOnOpen, isTrue, reason: 'child has downloadOnOpen + signed updates from the first start');
    final boundaryKey = GlobalKey();
    await tester.pumpWidget(
      MaterialApp(
        debugShowCheckedModeBanner: false,
        home: RepaintBoundary(
          key: boundaryKey,
          child: PocketSystemHost(
            systemUI: studioSystemUI(config),
            applications: {PocketStudioConfig.previewAppId: child},
            controller: controller,
          ),
        ),
      ),
    );

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
      fail('timed out waiting for $what: ${_diag(controller)}');
    }

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

    PocketSession studioSession() => controller.instances.firstWhere((i) => i.appId == studioAppId).session;
    Future<void> tapAt(double x, double y) async {
      for (final phase in const ['down', 'up']) {
        studioSession().controller.send(method: 'input.pointer', params: {'phase': phase, 'id': 0, 'x': x, 'y': y});
        await pumpFor(const Duration(milliseconds: 80));
      }
      await pumpFor(const Duration(milliseconds: 200));
    }

    PocketSystemInstanceSnapshot? preview() {
      for (final i in controller.instances) {
        if (i.appId == PocketStudioConfig.previewAppId) return i;
      }
      return null;
    }

    await waitUntil(() => controller.instances.any((i) => i.appId == studioAppId && i.firstFrameReady), 'Studio first frame');
    await pumpFor(const Duration(seconds: 3)); // project list, settings load
    await shot('boot');

    // Settings -> turn auto-build on (a real pointer tap on the switch).
    await tapAt(30, 244);
    await shot('settings');
    await tapAt(140, 74);
    await tapAt(300, 314); // editor: the multi-line InputField (the default is the CodeView; this M3 test types through the text overlay)
    await pumpFor(const Duration(seconds: 1));
    await shot('settings-autobuild');

    // Projects -> open the temp project.
    await tapAt(30, 39);
    await tapAt(300, 78);
    await pumpFor(const Duration(seconds: 2));
    await shot('project-open');

    // Source: open app.tsx and type a new version through the real Flutter text overlay.
    await tapAt(130, 160);
    await pumpFor(const Duration(seconds: 1));
    await shot('file-open');
    await tapAt(420, 130); // the multi-line InputField shell
    await pumpFor(const Duration(milliseconds: 500));
    await shot('editing');

    Future<void> editAndSave(String marker) async {
      final field = find.byType(EditableText);
      expect(field, findsWidgets, reason: 'the guest must have opened the Flutter text overlay');
      await tester.enterText(field.last, _source(marker));
      await pumpFor(const Duration(milliseconds: 500));
      await shot('typed-$marker');
      await tapAt(396, 34); // toolbar "保存"
      await shot('saved-$marker');
    }

    final base = childRecordings.length;
    // --- v1 ------------------------------------------------------------------------------------
    final save1 = Stopwatch()..start();
    await editAndSave('PREVIEW_V1');
    await waitUntil(() => File('${project.path}/app.tsx').readAsStringSync().contains('PREVIEW_V1'), 'v1 on disk');
    final onDisk1 = save1.elapsedMilliseconds;
    await waitUntil(() => preview()?.firstFrameReady == true && childRecordings.length > base, 'preview child first frame for v1');
    final latency1 = save1.elapsedMilliseconds;
    final child1 = preview()!;
    final build1 = child1.session.active?.build;
    expect(build1, isNotNull);
    final digests1 = _digests(childRecordings.last);
    expect(digests1, isNotEmpty);
    await shot('preview-v1');

    // --- v2: the child is reloaded (destroy + create) with the new signed build. -----------------
    await tapAt(420, 130);
    await pumpFor(const Duration(milliseconds: 400));
    final save2 = Stopwatch()..start();
    await editAndSave('PREVIEW_V2');
    await waitUntil(() => File('${project.path}/app.tsx').readAsStringSync().contains('PREVIEW_V2'), 'v2 on disk');
    final recordings2 = childRecordings.length;
    await waitUntil(() => childRecordings.length > recordings2 && preview()?.firstFrameReady == true && (preview()!.session.active?.build ?? 0) > build1!, 'preview child reloaded with v2');
    final latency2 = save2.elapsedMilliseconds;
    final digests2 = _digests(childRecordings.last);
    expect(digests2, isNotEmpty);
    expect(digests2.first, isNot(digests1.first), reason: 'the child frame changed to the new version');
    await shot('preview-v2');
    await pumpFor(const Duration(seconds: 6));
    await shot('preview-v2-settled');

    // ignore: avoid_print
    print('STUDIO_SAVE_TO_PREVIEW_LATENCY ${jsonEncode({
      'v1 cold (save -> disk ms)': onDisk1,
      'v1 cold (save -> preview first frame ms)': latency1,
      'v2 reload (save -> preview first frame ms)': latency2,
      'preview builds': [build1, preview()!.session.active?.build],
    })}');

    await tester.pumpWidget(const SizedBox.shrink());
    await tester.pump(const Duration(milliseconds: 100));
    binding.defaultBinaryMessenger.setMockMethodCallHandler(const MethodChannel('plugins.flutter.io/path_provider'), null);
  }, skip: skip != false, timeout: const Timeout(Duration(minutes: 6)));
}

String _diag(PocketSystemHostController c) =>
    c.instances.map((i) => '${i.appId}:first=${i.firstFrameReady}:build=${i.session.active?.build}:stage=${i.session.stage}:failure=${i.session.failure}').toList().toString();

List<String> _digests(PocketRecordingController recording) {
  if (!recording.isStarted) return const [];
  return [
    for (final entry in recording.snapshot().entries)
      if (entry.result['frame'] is Map && (entry.result['frame'] as Map)['opsSha'] is String) (entry.result['frame'] as Map)['opsSha'] as String,
  ];
}

String _source(String marker) => '''
import { mount } from "@pocketjs/framework/solid";
import { Screen, Text, View } from "@pocketjs/framework/solid/components";

mount(() => <Screen class="w-full h-full flex-col bg-white">
  <View class="flex-col gap-2 p-4">
    <Text class="text-base text-black">$marker</Text>
  </View>
</Screen>);
''';
