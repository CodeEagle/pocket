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
    try {
      await tester.pumpWidget(
        const Align(
          alignment: Alignment.topLeft,
          child: SizedBox(width: 390, height: 760, child: PocketHostApp()),
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
        PocketCanvasPainter.resetPaintInvocationCount();
        SchedulerBinding.instance.addTimingsCallback(collect);
        try {
          await action();
          await Future<void>.delayed(const Duration(milliseconds: 900));
        } finally {
          SchedulerBinding.instance.removeTimingsCallback(collect);
          debugPocketFrameDeltaAtOverride = original;
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
          'nativeP95Ms': percentile(native, .95),
          'nativeMaxMs': percentile(native, 1),
          'buildP95Ms': percentile(build, .95),
          'buildMaxMs': percentile(build, 1),
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
        for (final route in ['mobile', 'transitions', 'home']) {
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
          if (route == 'transitions') {
            expect(guest.texts(tester), contains('Route stack'));
          }
        }
      }
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
      await tester.pumpWidget(const SizedBox.shrink());
      await tester.pump();
    }
  });
}
