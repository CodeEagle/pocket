import 'dart:convert';
import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/foundation.dart';
import 'package:flutter/scheduler.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:pocket_flutter/pocket_flutter.dart';
import 'package:pocket_host/main.dart';
import 'package:pocket_live2d/pocket_live2d.dart';

import 'guest_interaction_test.dart' as guest;
import 'novel_test_driver.dart';
import 'novel_performance_support.dart';

double _percentile(List<double> values, double fraction) {
  if (values.isEmpty) return 0;
  final sorted = [...values]..sort();
  return sorted[((sorted.length - 1) * fraction).round()];
}

void main() {
  final binding = IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  binding.framePolicy = LiveTestWidgetsFlutterBindingFramePolicy.fullyLive;
  final isolatedSupport = IsolatedNovelSupportDirectory();
  setUp(() async => isolatedSupport.install());
  tearDown(() async => isolatedSupport.restore());

  testWidgets('profile the actual game reading and player workflows', (
    tester,
  ) async {
    final windows = <Map<String, Object?>>[];
    final original = debugPocketFrameDeltaAtOverride;
    final captureKey = GlobalKey();
    PocketLive2dPlugin? live2d;
    final lantern = showcaseNativePolicies['pocket.demo.lantern']!;
    final policies = {
      ...showcaseNativePolicies,
      'pocket.demo.lantern': lantern.copyWith(
        pluginFactories: [
          createLanternAudioPlugin,
          (_) {
            final plugin = PocketLive2dPlugin.fromBundledCatalog(
              catalogAsset: 'assets/apps/lantern/novel.native-assets.json',
              assetPrefix: 'assets/apps/lantern/',
            );
            live2d = plugin;
            return plugin;
          },
        ],
      ),
    };
    Future<void> sample(String scene, Future<void> Function() action) async {
      binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
      await tester.pump();
      final frames = <FrameTiming>[];
      final native = <double>[];
      final ops = <double>[];
      void collect(List<FrameTiming> timings) => frames.addAll(timings);
      debugPocketFrameDeltaAtOverride = (runtime, delta) {
        final watch = Stopwatch()..start();
        final result = original == null
            ? pocketFrameDeltaAt(runtime, delta)
            : original(runtime, delta);
        watch.stop();
        native.add(watch.elapsedMicroseconds / 1000);
        if (result != null) ops.add(result.ops.length.toDouble());
        return result;
      };
      PocketCanvasPainter.resetPaintInvocationCount();
      SchedulerBinding.instance.addTimingsCallback(collect);
      final elapsed = Stopwatch()..start();
      try {
        await action();
        // Observe real vsync; do not synthesize a 60 Hz test frame loop.
        await Future<void>.delayed(const Duration(milliseconds: 1600));
      } finally {
        elapsed.stop();
        SchedulerBinding.instance.removeTimingsCallback(collect);
        debugPocketFrameDeltaAtOverride = original;
      }
      final build = frames
          .map((f) => f.buildDuration.inMicroseconds / 1000)
          .toList();
      final raster = frames
          .map((f) => f.rasterDuration.inMicroseconds / 1000)
          .toList();
      final budget = 1000 / tester.view.display.refreshRate;
      final window = <String, Object?>{
        'variant': const String.fromEnvironment(
          'NOVEL_PROFILE_VARIANT',
          defaultValue: 'current',
        ),
        'scene': scene,
        'platform': defaultTargetPlatform.name,
        'mode': kProfileMode
            ? 'profile'
            : kReleaseMode
            ? 'release'
            : 'debug',
        'refreshHz': tester.view.display.refreshRate,
        'elapsedMs': elapsed.elapsedMilliseconds,
        'frames': frames.length,
        'nativeCalls': native.length,
        'nativeTotalMs': native.fold<double>(0, (sum, value) => sum + value),
        'nativeP50Ms': _percentile(native, .50),
        'nativeP95Ms': _percentile(native, .95),
        'nativeMaxMs': _percentile(native, 1),
        'buildP95Ms': _percentile(build, .95),
        'rasterP95Ms': _percentile(raster, .95),
        'overBudget': frames
            .where(
              (f) =>
                  f.buildDuration.inMicroseconds / 1000 > budget ||
                  f.rasterDuration.inMicroseconds / 1000 > budget,
            )
            .length,
        'opsMax': _percentile(ops, 1),
        'canvasPaints': PocketCanvasPainter.paintInvocationCount,
        'paintedOps': PocketCanvasPainter.drawOpInvocationCount,
        'textureTriangleBatches':
            PocketCanvasPainter.textureTriangleBatchDrawCount,
      };
      windows.add(window);
      // ignore: avoid_print
      print('POCKET_NOVEL_WINDOW ${jsonEncode(window)}');
      expect(tester.takeException(), isNull);
      const captureName = String.fromEnvironment('NOVEL_CAPTURE_DIRECTORY');
      if (captureName.isNotEmpty) {
        final captureDirectory = '${Directory.systemTemp.path}/$captureName';
        final boundary =
            captureKey.currentContext!.findRenderObject()!
                as RenderRepaintBoundary;
        final image = await boundary.toImage();
        try {
          final png = await image.toByteData(format: ui.ImageByteFormat.png);
          final path =
              '$captureDirectory/${windows.length.toString().padLeft(2, '0')}-$scene.png';
          await File(path).parent.create(recursive: true);
          await File(path).writeAsBytes(png!.buffer.asUint8List());
          // ignore: avoid_print
          print('POCKET_NOVEL_CAPTURE $path');
        } finally {
          image.dispose();
        }
      }
    }

    try {
      await sample('launch_title', () async {
        await tester.pumpWidget(
          RepaintBoundary(
            key: captureKey,
            child: pocketHostApp(
              nativePolicies: policies,
              showFlutterFps: false,
            ),
          ),
        );
        await guest.waitFor(tester, '00');
        await guest.tapGuest(tester, '雾港末班信 · Visual Novel');
        await guest.waitFor(tester, '启程 · 开始新的故事');
      });
      await sample('scene_reveal', () async {
        await guest.tapGuest(tester, '启程 · 开始新的故事', scroll: false);
        await guest.waitForContaining(tester, '23点08分');
      });
      await guest.waitFor(tester, '轻触继续  ›');
      for (var round = 0; round < 3; round++) {
        await sample('manual_reading_model_$round', () async {});
        expect(guest.texts(tester).join(), contains('23点08分'));
      }
      await sample('menu_open', () async {
        await guest.tapGuest(tester, '手札', scroll: false);
        await guest.waitFor(tester, '旅途手札');
      });
      for (final panel in ['沿途回声', '阅读偏好', '雾港纪念']) {
        await sample('panel_$panel', () async {
          await guest.tapGuest(tester, panel);
          await guest.waitFor(tester, '返回');
        });
        await guest.tapGuest(tester, '返回', scroll: false);
        await guest.tapGuest(tester, '手札', scroll: false);
        await guest.waitFor(tester, '旅途手札');
      }
      await sample('save_slot', () async {
        await guest.tapGuest(tester, '封存此刻');
        await saveNovelSlot(tester, '3');
      });
      await guest.tapGuest(tester, '返回', scroll: false);
      await guest.tapGuest(tester, '手札', scroll: false);
      await guest.waitFor(tester, '旅途手札');
      await sample('load_slot', () async {
        await guest.tapGuest(tester, '重读信笺');
        await waitForNovelSlotPage(tester);
        await guest.tapGuest(tester, '信笺 3');
        await guest.waitForContaining(tester, '23点08分');
      });
      await sample('story_advance', () async {
        await guest.tapGuest(tester, '轻触继续  ›', scroll: false);
        await guest.waitFor(tester, '轻触继续  ›');
      });
      await sample('rollback', () async {
        await guest.tapGuest(tester, '回溯');
        await guest.waitForContaining(tester, '23点08分');
      });
      await guest.tapGuest(tester, '手札', scroll: false);
      await guest.waitFor(tester, '旅途手札');
      await guest.tapGuest(tester, '雾港纪念');
      await guest.tapGuest(tester, '回看 · 立绘试映');
      Future<void> revealUntil(String target) async {
        for (var attempt = 0; attempt < 300; attempt++) {
          if (guest.texts(tester).any((label) => label.contains(target))) {
            return;
          }
          for (final hint in ['轻触继续  ›']) {
            if (guest.texts(tester).any((label) => label.contains(hint))) {
              await guest.tapGuest(tester, hint, scroll: false);
              break;
            }
          }
          await tester.pump(const Duration(milliseconds: 30));
          await tester.runAsync(
            () => Future<void>.delayed(const Duration(milliseconds: 5)),
          );
        }
        fail('The model theater did not reach $target: ${guest.texts(tester)}');
      }

      await revealUntil('官方 Hiyori · Live2D');
      await guest.tapGuest(tester, '官方 Hiyori · Live2D');
      await revealUntil('Idle 0 · 呼吸');
      await guest.tapGuest(tester, 'Idle 0 · 呼吸');
      await revealUntil('选择取景');
      for (var attempt = 0; attempt < 300; attempt++) {
        if (guest
                .painters(tester)
                .any(
                  (widget) => (widget.painter! as PocketCanvasPainter).ops
                      .whereType<PocketTextureTriangleOp>()
                      .any((op) => op.asset.contains('/Hiyori.2048/')),
                ) &&
            live2d?.activeModelCount == 1) {
          break;
        }
        await tester.pump(const Duration(milliseconds: 30));
        await tester.runAsync(
          () => Future<void>.delayed(const Duration(milliseconds: 10)),
        );
      }
      expect(
        guest
            .painters(tester)
            .any(
              (widget) => (widget.painter! as PocketCanvasPainter).ops
                  .whereType<PocketTextureTriangleOp>()
                  .any((op) => op.asset.contains('/Hiyori.2048/')),
            ),
        isTrue,
      );
      expect(live2d, isNotNull);
      expect(live2d!.activeModelCount, 1);
      expect(
        guest
            .painters(tester)
            .expand((widget) => (widget.painter! as PocketCanvasPainter).ops)
            .whereType<PocketTextureTriangleOp>()
            .where((op) => op.asset.contains('/Hiyori.2048/')),
        hasLength(greaterThan(10)),
      );
      for (var round = 0; round < 3; round++) {
        await sample('live2d_idle_$round', () async {});
      }
      await guest.tapGuest(tester, '返回动作目录');
      await guest.tapGuest(tester, '返回试映目录');
      for (
        var attempt = 0;
        attempt < 200 && live2d!.activeModelCount != 0;
        attempt++
      ) {
        await tester.pump(const Duration(milliseconds: 30));
      }
      expect(live2d!.activeModelCount, 0);
      await guest.tapGuest(tester, '回声', scroll: false);
      await guest.waitFor(tester, '沿途回声');
      await sample('live2d_paused_log', () async {});
      expect(
        windows.where((w) => (w['nativeCalls']! as int) > 0).length,
        greaterThan(8),
      );
      binding.reportData = {
        ...?binding.reportData,
        'novelPerformance': windows,
      };
    } finally {
      debugPocketFrameDeltaAtOverride = original;
      await tester.pumpWidget(const SizedBox.shrink());
      await tester.pump();
    }
  }, timeout: const Timeout(Duration(minutes: 5)));
}
