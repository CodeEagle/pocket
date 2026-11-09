import 'dart:ui' as ui;

import 'package:flutter/foundation.dart' show defaultTargetPlatform, listEquals;
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:pocket_audio/pocket_audio.dart';
import 'package:pocket_flutter/pocket_flutter.dart';
import 'package:pocket_host/main.dart'
    show pocketHostApp, showcaseNativePolicies, createLanternAudioPlugin;

import 'guest_interaction_test.dart' as guest;
import 'novel_test_driver.dart' as novel;

// One entry point runs unchanged on iOS, Android and desktop. The actual
// SystemHost owns storage transport and launches the shipped game QJBC.

List<PocketTextureTriangleOp> _modelOps(WidgetTester tester) => [
  for (final widget in guest.painters(tester))
    for (final op in (widget.painter! as PocketCanvasPainter).ops)
      if (op is PocketTextureTriangleOp && op.asset.contains('mira-')) op,
];

List<double> _modelPositions(WidgetTester tester) => [
  for (final op in _modelOps(tester))
    for (final point in op.points) ...[point.x, point.y],
];

Future<void> _pumpFor(WidgetTester tester, Duration duration) async {
  for (var elapsed = 0; elapsed < duration.inMilliseconds; elapsed += 30) {
    await tester.pump(const Duration(milliseconds: 30));
  }
}

Future<void> _pressKey(WidgetTester tester, LogicalKeyboardKey key) async {
  // Guest input samples held buttons once per frame. Keep the physical down
  // edge visible for a frame before releasing the key.
  await tester.sendKeyDownEvent(key);
  await tester.pump(const Duration(milliseconds: 30));
  await tester.sendKeyUpEvent(key);
  await tester.pump(const Duration(milliseconds: 30));
}

Future<void> _expectModelPixels(WidgetTester tester) async {
  final painter = guest
      .painters(tester)
      .map((widget) => widget.painter! as PocketCanvasPainter)
      .firstWhere(
        (value) => value.ops.any(
          (op) => op is PocketTextureTriangleOp && op.asset.contains('mira-'),
        ),
      );
  final meshes = painter.ops
      .whereType<PocketTextureTriangleOp>()
      .where((op) => op.asset.contains('mira-'))
      .toList();
  expect(meshes.length, greaterThan(10));
  for (final mesh in meshes) {
    expect(
      painter.images[mesh.asset],
      isNotNull,
      reason: 'Model texture must actually be decoded on this platform',
    );
  }
  final recorder = ui.PictureRecorder();
  PocketCanvasPainter(
    width: painter.width,
    height: painter.height,
    ops: meshes,
    images: painter.images,
  ).paint(Canvas(recorder), Size(painter.width, painter.height));
  final picture = recorder.endRecording();
  final image = await tester.runAsync(
    () => picture.toImage(painter.width.ceil(), painter.height.ceil()),
  );
  try {
    final pixels = await tester.runAsync(
      () => image!.toByteData(format: ui.ImageByteFormat.rawRgba),
    );
    expect(pixels, isNotNull);
    var opaquePixels = 0;
    final colors = <int>{};
    for (var offset = 0; offset < pixels!.lengthInBytes; offset += 4) {
      if (pixels.getUint8(offset + 3) > 32) {
        opaquePixels++;
        if (colors.length < 32) {
          colors.add(pixels.getUint32(offset));
        }
      }
    }
    expect(
      opaquePixels,
      greaterThan(300),
      reason: 'Real model triangles must paint visible pixels',
    );
    expect(
      colors.length,
      greaterThan(8),
      reason: 'The model must sample its texture, rather than a solid fill',
    );
  } finally {
    image?.dispose();
    picture.dispose();
  }
}

void main() {
  final binding = IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  final desktop = <TargetPlatform>{
    TargetPlatform.macOS,
    TargetPlatform.windows,
    TargetPlatform.linux,
  }.contains(defaultTargetPlatform);

  Future<void> journal(WidgetTester tester) async {
    if (desktop) {
      await _pressKey(tester, LogicalKeyboardKey.escape);
      await guest.waitFor(tester, '旅途手札');
    } else {
      await guest.tapGuest(tester, '手札', scroll: false);
    }
  }

  testWidgets('Lantern runs, animates, saves and resumes on the real platform', (
    tester,
  ) async {
    PocketAudioPlugin? audio;
    try {
      debugPrint('novel-platform: mounting SystemHost');
      await tester.pumpWidget(
        pocketHostApp(
          nativePolicies: {
            ...showcaseNativePolicies,
            'pocket.demo.lantern':
                showcaseNativePolicies['pocket.demo.lantern']!.copyWith(
                  pluginFactories: [
                    (controller) {
                      final plugin =
                          createLanternAudioPlugin(controller)
                              as PocketAudioPlugin;
                      audio = plugin;
                      return plugin;
                    },
                  ],
                ),
          },
        ),
      );
      debugPrint('novel-platform: waiting for Showcase');
      await guest.waitFor(tester, '00');
      await guest.tapGuest(tester, '雾港末班信 · Visual Novel');
      debugPrint('novel-platform: launched game');
      await guest.waitFor(tester, '启程 · 开始新的故事');
      if (desktop) {
        await _pressKey(tester, LogicalKeyboardKey.enter);
      } else {
        await guest.tapGuest(tester, '启程 · 开始新的故事', scroll: false);
      }
      await guest.waitForContaining(tester, '23点08分');
      if (desktop) {
        await _pressKey(tester, LogicalKeyboardKey.space);
        await guest.waitFor(tester, '轻触继续  ›');
        await journal(tester);
        await _pressKey(tester, LogicalKeyboardKey.escape);
        await guest.waitFor(tester, '轻触继续  ›');
        await guest.waitForContaining(tester, '23点08分');
      }
      await _pumpFor(tester, const Duration(milliseconds: 1100));
      await _expectModelPixels(tester);
      debugPrint('novel-platform: decoded textured model pixels');
      final before = _modelPositions(tester);
      await _pumpFor(tester, const Duration(milliseconds: 400));
      expect(
        _modelPositions(tester),
        isNot(equals(before)),
        reason: 'Official Spine execution must deform the rendered model',
      );

      // Finish this line with real pointer input, then save through JS and the
      // actual platform storage provider. No private engine state is injected.
      if (guest.texts(tester).contains('轻触显全')) {
        await guest.tapGuest(tester, '轻触显全', scroll: false);
      }
      await guest.waitFor(tester, '轻触继续  ›');
      await journal(tester);
      await guest.tapGuest(tester, '封存此刻', scroll: false);
      await novel.saveNovelSlot(tester, '1');
      await guest.tapGuest(tester, '返回', scroll: false);
      if (desktop) {
        await _pressKey(tester, LogicalKeyboardKey.enter);
      } else {
        await guest.tapGuest(tester, '轻触继续  ›', scroll: false);
      }
      await guest.waitForContaining(tester, '我送一封信');

      Future<Map<String, dynamic>> voiceFacts() async =>
          Map<String, dynamic>.from(
            audio!.snapshotChannel('__pocket_vn_voice'),
          );
      var voice = await voiceFacts();
      expect(voice['playing'], isTrue);
      expect(voice['durationMs'] as int, greaterThan(13000));
      await journal(tester);
      await _pumpFor(tester, const Duration(milliseconds: 250));
      expect((await voiceFacts())['playing'], isFalse);
      await guest.tapGuest(tester, '继续阅读', scroll: false);
      await _pumpFor(tester, const Duration(milliseconds: 250));
      expect((await voiceFacts())['playing'], isTrue);
      await guest.tapGuest(tester, '重听配音', scroll: false);
      await _pumpFor(tester, const Duration(milliseconds: 200));
      voice = await voiceFacts();
      expect(voice['playing'], isTrue);
      expect(voice['positionMs'] as int, lessThan(1200));
      if (guest.texts(tester).contains('轻触显全')) {
        await guest.tapGuest(tester, '轻触显全', scroll: false);
      }
      await guest.tapGuest(tester, '自动', scroll: false);
      await _pumpFor(tester, const Duration(seconds: 4));
      await guest.waitForContaining(tester, '我送一封信');
      voice = await voiceFacts();
      // Wait for the actual decoder's remaining wall-clock duration, then let
      // its tokenized completion travel through the normal bridge into QJBC.
      await tester.runAsync(
        () => Future<void>.delayed(
          Duration(
            milliseconds:
                (voice['durationMs'] as int) -
                (voice['positionMs'] as int) +
                300,
          ),
        ),
      );
      await _pumpFor(tester, const Duration(seconds: 1));
      await guest.waitForContaining(tester, '旧灯号中继');
      debugPrint('novel-platform: real voice completion advanced JS auto');

      await journal(tester);
      await guest.tapGuest(tester, '重读信笺', scroll: false);
      await novel.waitForNovelSlotPage(tester);
      await guest.tapGuest(tester, '信笺 1', scroll: false);
      await guest.waitForContaining(tester, '23点08分');

      debugPrint('novel-platform: saved and restored slot 1');

      Future<Map<String, dynamic>> musicFacts() async =>
          Map<String, dynamic>.from(audio!.snapshotChannel('music'));
      expect((await musicFacts())['playing'], isTrue);

      // Exercise the same OS lifecycle callback used by a real app switch.
      binding.handleAppLifecycleStateChanged(AppLifecycleState.inactive);
      binding.handleAppLifecycleStateChanged(AppLifecycleState.paused);
      final paused = _modelPositions(tester);
      final activeView = guest.activePocketViewFinder();
      final dynamic view = tester.state(activeView);
      final controller = tester.widget<PocketView>(activeView).controller;
      expect(controller, isNotNull);
      expect(view.isTickerActive, isFalse);
      // A paused real engine does not deliver vsync. Await wall time without
      // asking the binding for a frame that the OS deliberately withholds.
      await tester.runAsync(
        () => Future<void>.delayed(const Duration(milliseconds: 600)),
      );
      expect(
        _modelPositions(tester),
        equals(paused),
        reason: 'Background time must not advance the game animation',
      );
      binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
      // Session reactivation awaits real native plugin operations before
      // publishing appActive. Observe that boundary rather than spending the
      // animation's fixed frame budget while the provider is still starting.
      final activation = Stopwatch()..start();
      while (!controller!.appActive &&
          activation.elapsed < const Duration(seconds: 10)) {
        await tester.pump(const Duration(milliseconds: 30));
      }
      expect(
        controller.appActive,
        isTrue,
        reason: 'Native capabilities must finish reactivation after resume',
      );
      // The demand-driven scheduler can park the ticker between deadlines.
      // Require several distinct deformed frames instead of requiring a
      // continuously active ticker or sampling one looping-motion endpoint.
      var changedFrames = 0;
      var previous = paused;
      for (var frame = 0; frame < 100 && changedFrames < 3; frame++) {
        await tester.pump(const Duration(milliseconds: 30));
        final positions = _modelPositions(tester);
        if (positions.isNotEmpty &&
            positions.length == previous.length &&
            !listEquals(positions, previous)) {
          changedFrames++;
          previous = positions;
        }
      }
      debugPrint(
        'novel-platform: resumed lifecycle=${binding.lifecycleState}, '
        'activationMs=${activation.elapsedMilliseconds}, '
        'ticker=${view.isTickerActive}, wake=${view.hasScheduledWake}, '
        'deformedFrames=$changedFrames',
      );
      expect(
        changedFrames,
        greaterThanOrEqualTo(3),
        reason: 'Resuming must keep producing deformed model frames',
      );
      expect(
        (await musicFacts())['playing'],
        isTrue,
        reason: 'The existing JS audio intent must resume after backgrounding',
      );
      await guest.waitForContaining(tester, '23点08分');
    } finally {
      binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
      await tester.pumpWidget(const SizedBox.shrink());
      await tester.pump();
    }
  }, timeout: const Timeout(Duration(minutes: 3)));
}
