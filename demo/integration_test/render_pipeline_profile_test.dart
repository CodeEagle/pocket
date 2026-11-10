import 'dart:convert';
import 'dart:ui';
import 'package:flutter/foundation.dart';
import 'package:flutter/scheduler.dart';
import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:pocket_flutter/pocket_flutter.dart';
import 'package:pocket_host/main.dart';
import 'guest_interaction_test.dart' as guest;

double percentile(List<double> values, double fraction) {
  if (values.isEmpty) return 0;
  final ordered = [...values]..sort();
  return ordered[((ordered.length - 1) * fraction).round()];
}

void main() {
  final binding = IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  binding.framePolicy = LiveTestWidgetsFlutterBindingFramePolicy.fullyLive;
  testWidgets('profile real transitions and input without a frame driver', (
    tester,
  ) async {
    final windows = <Map<String, Object?>>[];
    final original = debugPocketFrameDeltaAtOverride;
    final originalTickAttribution = debugOnPocketTickAttribution;
    final originalFrameStageAttribution = debugOnPocketFrameStageAttribution;
    try {
      await tester.pumpWidget(
        Align(
          alignment: Alignment.topLeft,
          child: SizedBox(width: 390, height: 760, child: pocketHostApp()),
        ),
      );
      await guest.waitFor(tester, 'Home');
      await Future<void>.delayed(const Duration(seconds: 1));
      final controller = tester
          .widget<PocketView>(find.byType(PocketView).first)
          .controller!;
      Future<void> sample(String scene, Future<void> Function() action) async {
        // Desktop focus changes report inactive. Control the test lifecycle so
        // a background driver cannot measure a deliberately suspended guest.
        binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
        await tester.pump();
        final timings = <FrameTiming>[];
        final native = <double>[];
        final decode = <double>[];
        final diff = <double>[];
        final stageBuild = <double>[];
        final stagePaint = <double>[];
        final jsTick = <double>[];
        final live2dUpdate = <double>[];
        final live2dEmit = <double>[];
        final relayout = <double>[];
        final drawDecode = <double>[];
        final splice = <double>[];
        final encode = <double>[];
        final other = <double>[];
        final ops = <double>[];
        void collect(List<FrameTiming> frames) => timings.addAll(frames);
        debugPocketFrameDeltaAtOverride = (runtime, delta) {
          final clock = Stopwatch()..start();
          final result = original == null
              ? pocketFrameDeltaAt(runtime, delta)
              : original(runtime, delta);
          clock.stop();
          native.add(clock.elapsedMicroseconds / 1000);
          if (result != null) ops.add(result.ops.length.toDouble());
          return result;
        };
        debugOnPocketTickAttribution = ({
          required nativeMs,
          required decodeMs,
          required diffMs,
          PocketNativeStageTimings nativeStages = PocketNativeStageTimings.zero,
        }) {
          decode.add(decodeMs);
          diff.add(diffMs);
          jsTick.add(nativeStages.jsTickMs);
          live2dUpdate.add(nativeStages.live2dUpdateMs);
          live2dEmit.add(nativeStages.live2dEmitMs);
          relayout.add(nativeStages.relayoutMs);
          drawDecode.add(nativeStages.drawDecodeMs);
          splice.add(nativeStages.spliceMs);
          encode.add(nativeStages.encodeMs);
          other.add(nativeStages.otherMs);
        };
        debugOnPocketFrameStageAttribution = ({buildMs, paintMs}) {
          if (buildMs != null) stageBuild.add(buildMs);
          if (paintMs != null) stagePaint.add(paintMs);
        };
        PocketCanvasPainter.resetPaintInvocationCount();
        SchedulerBinding.instance.addTimingsCallback(collect);
        try {
          await action();
          await Future<void>.delayed(const Duration(milliseconds: 900));
          await tester.pump();
        } finally {
          SchedulerBinding.instance.removeTimingsCallback(collect);
          debugPocketFrameDeltaAtOverride = original;
          debugOnPocketTickAttribution = originalTickAttribution;
          debugOnPocketFrameStageAttribution = originalFrameStageAttribution;
        }
        final build = timings
            .map((f) => f.buildDuration.inMicroseconds / 1000)
            .toList();
        final raster = timings
            .map((f) => f.rasterDuration.inMicroseconds / 1000)
            .toList();
        final budget = 1000 / tester.view.display.refreshRate;
        windows.add({
          'scene': scene,
          'mode': kProfileMode
              ? 'profile'
              : kReleaseMode
              ? 'release'
              : 'debug',
          'refreshHz': tester.view.display.refreshRate,
          'lifecycle': binding.lifecycleState?.name,
          'frames': timings.length,
          'nativeCalls': native.length,
          'nativeP50Ms': percentile(native, .50),
          'nativeP95Ms': percentile(native, .95),
          'nativeMaxMs': percentile(native, 1),
          'decodeP50Ms': percentile(decode, .50),
          'decodeP95Ms': percentile(decode, .95),
          'diffP50Ms': percentile(diff, .50),
          'diffP95Ms': percentile(diff, .95),
          'nativeJsTickP50Ms': percentile(jsTick, .50),
          'nativeJsTickP95Ms': percentile(jsTick, .95),
          'nativeLive2dUpdateP50Ms': percentile(live2dUpdate, .50),
          'nativeLive2dUpdateP95Ms': percentile(live2dUpdate, .95),
          'nativeLive2dEmitP50Ms': percentile(live2dEmit, .50),
          'nativeLive2dEmitP95Ms': percentile(live2dEmit, .95),
          'nativeRelayoutP50Ms': percentile(relayout, .50),
          'nativeRelayoutP95Ms': percentile(relayout, .95),
          'nativeDrawDecodeP50Ms': percentile(drawDecode, .50),
          'nativeDrawDecodeP95Ms': percentile(drawDecode, .95),
          'nativeSpliceP50Ms': percentile(splice, .50),
          'nativeSpliceP95Ms': percentile(splice, .95),
          'nativeEncodeP50Ms': percentile(encode, .50),
          'nativeEncodeP95Ms': percentile(encode, .95),
          'nativeOtherP50Ms': percentile(other, .50),
          'nativeOtherP95Ms': percentile(other, .95),
          'pocketBuildP50Ms': percentile(stageBuild, .50),
          'pocketBuildP95Ms': percentile(stageBuild, .95),
          'pocketPaintP50Ms': percentile(stagePaint, .50),
          'pocketPaintP95Ms': percentile(stagePaint, .95),
          'buildP50Ms': percentile(build, .50),
          'buildP95Ms': percentile(build, .95),
          'buildMaxMs': percentile(build, 1),
          'rasterP50Ms': percentile(raster, .50),
          'rasterP95Ms': percentile(raster, .95),
          'rasterMaxMs': percentile(raster, 1),
          'overBudget': timings
              .where(
                (f) =>
                    f.buildDuration.inMicroseconds / 1000 > budget ||
                    f.rasterDuration.inMicroseconds / 1000 > budget,
              )
              .length,
          'opsMax': percentile(ops, 1),
          'canvasPaints': PocketCanvasPainter.paintInvocationCount,
          'paintedOps': PocketCanvasPainter.drawOpInvocationCount,
          'retainedBlocks': guest.painters(tester).length,
        });
        // ignore: avoid_print
        print('POCKET_RENDER_WINDOW ${jsonEncode(windows.last)}');
        expect(tester.takeException(), isNull);
      }

      await sample('home_idle', () async {});
      for (var round = 0; round < 3; round++) {
        for (final route in ['mobile', 'gallery', 'transitions', 'home']) {
          await sample('$route-$round', () async {
            expect(
              controller.send(
                method: 'demo.navigate',
                params: {'route': route},
              ),
              isTrue,
            );
          });
          if (route == 'mobile') {
            expect(guest.texts(tester), contains('Scaffold + AppBar'));
          }
          if (route == 'gallery') {
            expect(guest.texts(tester), contains('Official building blocks'));
          }
          if (route == 'transitions') {
            expect(guest.texts(tester), contains('Route stack'));
          }
        }
      }
      await guest.reveal(tester, 'Profile · Sheet');
      await sample('miniapp_sheet_open', () async {
        await guest.tapGuest(tester, 'Profile · Sheet', scroll: false);
        await guest.waitFor(tester, 'Pocket Profile');
      });
      await sample('miniapp_sheet_close', () async {
        await guest.tapGuest(tester, 'Return to Showcase');
        await guest.waitForContaining(tester, 'Profile · Sheet');
      });
      await guest.reveal(tester, 'Profile · Page');
      await sample('miniapp_page_open', () async {
        await guest.tapGuest(tester, 'Profile · Page', scroll: false);
        await guest.waitFor(tester, 'Pocket Profile');
      });
      await sample('miniapp_page_close', () async {
        await guest.tapGuest(tester, 'Return to Showcase');
        await guest.waitForContaining(tester, 'Profile · Page');
      });
      expect(
        controller.send(
          method: 'demo.navigate',
          params: {'route': 'mobile'},
        ),
        isTrue,
      );
      await guest.waitFor(tester, 'Scaffold + AppBar');
      await sample('mobile_scroll', () async {
        final box = tester.renderObject<RenderBox>(
          find.byType(PocketView).first,
        );
        final gesture = await tester.startGesture(
          box.localToGlobal(Offset(box.size.width * .5, box.size.height * .75)),
        );
        for (var index = 0; index < 12; index++) {
          for (var move = 0; move < 8; move++) {
            await gesture.moveTo(
              box.localToGlobal(
                Offset(
                  box.size.width * .5,
                  box.size.height * (.75 - (index * 8 + move) / 240),
                ),
              ),
            );
          }
          await Future<void>.delayed(const Duration(milliseconds: 16));
        }
        await gesture.up();
      });
      expect(
        controller.send(
          method: 'demo.navigate',
          params: {'route': 'home'},
        ),
        isTrue,
      );
      await guest.waitFor(tester, 'Mini Apps');
      Map<String, double> textPositions() => {
        for (final paint in guest.painters(tester))
          for (final op in (paint.painter! as PocketCanvasPainter).ops)
            if (op is PocketTextOp) op.text: op.y,
      };
      var movedTextOps = 0;
      await sample('home_pointer_burst', () async {
        final before = textPositions();
        final box = tester.renderObject<RenderBox>(
          find.byType(PocketView).first,
        );
        final gesture = await tester.startGesture(
          box.localToGlobal(Offset(box.size.width * .5, box.size.height * .75)),
        );
        for (var index = 0; index < 12; index++) {
          for (var move = 0; move < 8; move++) {
            await gesture.moveTo(
              box.localToGlobal(
                Offset(
                  box.size.width * .5,
                  box.size.height * (.75 - (index * 8 + move) / 240),
                ),
              ),
            );
          }
          await Future<void>.delayed(const Duration(milliseconds: 16));
          final moved = textPositions().entries.where((entry) {
            final previous = before[entry.key];
            return previous != null && (previous - entry.value).abs() >= 1;
          }).length;
          if (moved > movedTextOps) movedTextOps = moved;
        }
        await gesture.up();
      });
      windows.last['movedTextOps'] = movedTextOps;
      expect(
        movedTextOps,
        greaterThan(0),
        reason: 'drag must move real JS DrawOps',
      );
      expect(
        windows.last['nativeCalls'],
        greaterThan(0),
        reason: 'pointer workload must actually reach the JS runtime',
      );
      expect(
        windows.map((w) => w['nativeCalls']! as int).reduce((a, b) => a + b),
        greaterThan(10),
      );
      binding.reportData = {'renderPipeline': windows};
      // ignore: avoid_print
      print('POCKET_RENDER_PIPELINE ${jsonEncode(windows)}');
    } finally {
      debugPocketFrameDeltaAtOverride = original;
      debugOnPocketTickAttribution = originalTickAttribution;
      debugOnPocketFrameStageAttribution = originalFrameStageAttribution;
      await tester.pumpWidget(const SizedBox.shrink());
      await tester.pump();
    }
  });
}
