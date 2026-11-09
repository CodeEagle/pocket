import 'dart:convert';
import 'dart:io';
import 'dart:math' as math;
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:path_provider/path_provider.dart';
import 'package:pocket_audio/pocket_audio.dart';
import 'package:pocket_flutter/pocket_flutter.dart';
import 'package:pocket_host/main.dart';
import 'package:pocket_sdk/pocket_sdk.dart';

import 'guest_interaction_test.dart' as guest;
import 'novel_performance_support.dart';

Iterable<PocketCanvasPainter> _painters(WidgetTester tester) => tester
    .widgetList<CustomPaint>(
      find.descendant(
        of: guest.activePocketViewFinder(),
        matching: find.byWidgetPredicate(
          (widget) =>
              widget is CustomPaint && widget.painter is PocketCanvasPainter,
        ),
      ),
    )
    .map((widget) => widget.painter! as PocketCanvasPainter);

// This fixture's static PNG can be emitted as an image quad or as its two
// viewport-clipped texture triangles. Reconstruct only that affine quad from
// UVs; this is not a bound reconstruction for arbitrary deforming meshes.
List<Offset> _staticImageQuadFromTriangle(PocketTextureTriangleOp op) {
  final fallback = op.points.map((point) => Offset(point.x, point.y)).toList();
  if (op.points.length != 3 || op.uvs.length != 6) return fallback;
  if (op.uvs.any((value) => !value.isFinite) ||
      op.points.any((point) => !point.x.isFinite || !point.y.isFinite)) {
    return fallback;
  }

  final u0 = op.uvs[0];
  final v0 = op.uvs[1];
  final du1 = op.uvs[2] - u0;
  final dv1 = op.uvs[3] - v0;
  final du2 = op.uvs[4] - u0;
  final dv2 = op.uvs[5] - v0;
  final determinant = du1 * dv2 - du2 * dv1;
  if (!determinant.isFinite || determinant.abs() < 1e-9) return fallback;

  final p0 = op.points[0];
  final p1 = op.points[1];
  final p2 = op.points[2];
  final dx1 = p1.x - p0.x;
  final dx2 = p2.x - p0.x;
  final dy1 = p1.y - p0.y;
  final dy2 = p2.y - p0.y;
  final xU = (dx1 * dv2 - dx2 * dv1) / determinant;
  final xV = (du1 * dx2 - du2 * dx1) / determinant;
  final yU = (dy1 * dv2 - dy2 * dv1) / determinant;
  final yV = (du1 * dy2 - du2 * dy1) / determinant;
  final xOrigin = p0.x - xU * u0 - xV * v0;
  final yOrigin = p0.y - yU * u0 - yV * v0;
  final corners = <Offset>[
    Offset(xOrigin, yOrigin),
    Offset(xOrigin + xU, yOrigin + yU),
    Offset(xOrigin + xU + xV, yOrigin + yU + yV),
    Offset(xOrigin + xV, yOrigin + yV),
  ];
  if (corners.any((point) => !point.dx.isFinite || !point.dy.isFinite)) {
    return fallback;
  }
  return corners;
}

Rect _bounds(WidgetTester tester, String suffix) {
  final points = <Offset>[];
  for (final painter in _painters(tester)) {
    for (final op in painter.ops) {
      if (op is PocketImageOp && op.asset.endsWith(suffix)) {
        expect(painter.images[op.asset], isNotNull);
        // Native quads are clipped to the viewport; recover the full image
        // extent from its actual UV span rather than expecting overflow ops.
        final uv = op.uv ?? const [0.0, 0.0, 1.0, 1.0];
        final width = op.width / (uv[2] - uv[0]);
        final height = op.height / (uv[3] - uv[1]);
        final left = op.x - uv[0] * width;
        final top = op.y - uv[1] * height;
        points.addAll([Offset(left, top), Offset(left + width, top + height)]);
      } else if (op is PocketTextureTriangleOp && op.asset.endsWith(suffix)) {
        expect(painter.images[op.asset], isNotNull);
        points.addAll(_staticImageQuadFromTriangle(op));
      }
    }
  }
  expect(
    points,
    isNotEmpty,
    reason: 'Decoded native art must be painted: $suffix',
  );
  return Rect.fromLTRB(
    points.map((p) => p.dx).reduce(math.min),
    points.map((p) => p.dy).reduce(math.min),
    points.map((p) => p.dx).reduce(math.max),
    points.map((p) => p.dy).reduce(math.max),
  );
}

List<Map<String, Object?>> _assetFacts(WidgetTester tester, String suffix) {
  final facts = <Map<String, Object?>>[];
  for (final painter in _painters(tester)) {
    for (final op in painter.ops) {
      if (op is PocketImageOp && op.asset.endsWith(suffix)) {
        final clip = op.clip;
        facts.add({
          'type': 'image',
          'x': op.x,
          'y': op.y,
          'width': op.width,
          'height': op.height,
          'uv': op.uv,
          'clip': clip == null
              ? null
              : [clip.x, clip.y, clip.width, clip.height],
        });
      } else if (op is PocketTextureTriangleOp && op.asset.endsWith(suffix)) {
        final clip = op.clip;
        facts.add({
          'type': 'textureTriangle',
          'x': op.x,
          'y': op.y,
          'width': op.width,
          'height': op.height,
          'points': [
            for (final point in op.points) [point.x, point.y],
          ],
          'uvs': op.uvs,
          'clip': clip == null
              ? null
              : [clip.x, clip.y, clip.width, clip.height],
        });
      }
    }
  }
  return facts;
}

Future<void> _frame(WidgetTester tester) async {
  await tester.pump(const Duration(milliseconds: 20));
  await tester.runAsync(
    () => Future<void>.delayed(const Duration(milliseconds: 5)),
  );
}

Future<void> _tap(WidgetTester tester, String label) async {
  final point = await guest.reveal(tester, label, scroll: false);
  final gesture = await tester.startGesture(point);
  await _frame(tester);
  await gesture.up();
  await _frame(tester);
}

Future<void> _advance(WidgetTester tester) async {
  if (!guest.texts(tester).contains('轻触继续  ›')) await _tap(tester, '轻触显全');
  await guest.waitFor(tester, '轻触继续  ›');
  await _tap(tester, '轻触继续  ›');
}

// This test supplies platform facts at Flutter's official test boundary. All
// visual policy and timeline progression still execute in shipped JS bytecode.
void main() {
  final binding = IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  final completed = <String>[];
  binding.reportData = {
    'pocketAcceptance': {
      'required': [
        'timeline-reduced-decoded-pose',
        'timeline-reduced-live-toggle',
        'timeline-reduced-real-audio',
        'timeline-reduced-normal-store-preserved',
      ],
      'completed': completed,
    },
  };
  testWidgets('shipped timeline honors dynamic host reduce-motion facts', (
    tester,
  ) async {
    final supportPath = await getApplicationSupportDirectory();
    final store = File(
      '${supportPath.path}/pocket-platform-data/pocket_platform_data.json',
    );
    final before = await tester.runAsync(
      () async => await store.exists() ? store.readAsBytes() : null,
    );
    final support = IsolatedNovelSupportDirectory();
    await support.install();
    final system = PocketSystemHostController();
    final policy = showcaseNativePolicies['pocket.demo.lantern']!;
    PocketAudioPlugin? audio;
    final captureKey = GlobalKey();
    final evidence = await Directory.systemTemp.createTemp(
      'pocket-timeline-reduced-',
    );
    final samples = <Map<String, Object?>>[];
    Future<void> capture(String name) async {
      final bg = _bounds(tester, 'art/station.png');
      final actor = _bounds(tester, 'art/mira-neutral.png');
      final boundary =
          captureKey.currentContext!.findRenderObject()!
              as RenderRepaintBoundary;
      final image = await tester.runAsync(() => boundary.toImage());
      final data = await tester.runAsync(
        () => image!.toByteData(format: ui.ImageByteFormat.png),
      );
      final png = data!.buffer.asUint8List(
        data.offsetInBytes,
        data.lengthInBytes,
      );
      final path = '${evidence.path}/$name.png';
      await tester.runAsync(() => File(path).writeAsBytes(png));
      image!.dispose();
      samples.add({
        'name': name,
        'background': [bg.left, bg.top, bg.width, bg.height],
        'actor': [actor.left, actor.top, actor.width, actor.height],
        'actorOps': _assetFacts(tester, 'art/mira-neutral.png'),
        'capture': path,
        // Preserve successful PNG evidence in the host test report because
        // Android removes the profile app's private temp directory at teardown.
        'pngBase64': base64Encode(png),
      });
    }

    void near(Rect actual, Rect expected) {
      expect((actual.left - expected.left).abs(), lessThan(.5));
      expect((actual.top - expected.top).abs(), lessThan(.5));
      expect((actual.width - expected.width).abs(), lessThan(.5));
      expect((actual.height - expected.height).abs(), lessThan(.5));
    }

    try {
      binding.platformDispatcher.accessibilityFeaturesTestValue =
          const FakeAccessibilityFeatures(disableAnimations: true);
      await tester.pumpWidget(
        RepaintBoundary(
          key: captureKey,
          child: pocketHostApp(
            systemController: system,
            nativePolicies: {
              ...showcaseNativePolicies,
              'pocket.demo.lantern': policy.copyWith(
                pluginFactories: [
                  (controller) {
                    audio =
                        createLanternAudioPlugin(controller)
                            as PocketAudioPlugin;
                    return audio!;
                  },
                  ...policy.pluginFactories.skip(1),
                ],
              ),
            },
          ),
        ),
      );
      await guest.waitFor(tester, '00');
      await guest.tapGuest(tester, '雾港末班信 · Visual Novel');
      await guest.waitFor(tester, '启程 · 开始新的故事');
      await guest.tapGuest(tester, '灯塔合奏');
      await guest.waitForContaining(tester, '站台的钟声');
      final baselineBg = _bounds(tester, 'art/station.png');
      final baselineActor = _bounds(tester, 'art/mira-neutral.png');
      await _advance(tester);
      for (var i = 0; i < 45; i++) {
        await _frame(tester);
      }
      near(_bounds(tester, 'art/station.png'), baselineBg);
      near(_bounds(tester, 'art/mira-neutral.png'), baselineActor);
      await capture('reduced');
      completed.add('timeline-reduced-decoded-pose');
      binding.platformDispatcher.accessibilityFeaturesTestValue =
          const FakeAccessibilityFeatures();
      await _frame(tester);
      await _frame(tester);
      expect(
        _bounds(tester, 'art/station.png').width,
        greaterThan(baselineBg.width * 1.03),
      );
      await capture('motion-restored');
      binding.platformDispatcher.accessibilityFeaturesTestValue =
          const FakeAccessibilityFeatures(disableAnimations: true);
      await _frame(tester);
      await _frame(tester);
      near(_bounds(tester, 'art/station.png'), baselineBg);
      near(_bounds(tester, 'art/mira-neutral.png'), baselineActor);
      completed.add('timeline-reduced-live-toggle');
      Map<String, Object?>? bell;
      for (var i = 0; i < 180 && bell == null; i++) {
        await _frame(tester);
        for (var channel = 0; channel < 4; channel++) {
          final fact = audio!.snapshotChannel('effect-$channel');
          if (fact['asset'] == 'audio/station_bell.wav' &&
              fact['playerPresent'] == true &&
              (fact['durationMs'] as num? ?? 0) > 0) {
            bell = Map<String, Object?>.from(fact);
          }
        }
      }
      expect(
        bell,
        isNotNull,
        reason: 'Reduce motion must preserve the real 1800ms cue and decode',
      );
      near(_bounds(tester, 'art/station.png'), baselineBg);
      completed.add('timeline-reduced-real-audio');
      binding.reportData!['timelineReduced'] = {
        'samples': samples,
        'audio': bell,
        'factBoundary':
            'Flutter TestPlatformDispatcher FakeAccessibilityFeatures, not an OS setting → MediaQuery → PocketView host event → JS provider',
      };
    } finally {
      binding.platformDispatcher.clearAccessibilityFeaturesTestValue();
      final sessions = system.instances.map((fact) => fact.session).toList();
      await tester.pumpWidget(const SizedBox.shrink());
      await tester.pump();
      await tester.runAsync(
        () => Future.wait(sessions.map((session) => session.close())),
      );
      system.dispose();
      await support.restore();
      binding.reportData!['timelineReduced'] ??= {
        'samples': samples,
        'factBoundary':
            'Flutter TestPlatformDispatcher FakeAccessibilityFeatures, not an OS setting → MediaQuery → PocketView host event → JS provider',
      };
      final after = await tester.runAsync(
        () async => await store.exists() ? store.readAsBytes() : null,
      );
      expect(after, equals(before));
      completed.add('timeline-reduced-normal-store-preserved');
      expect(tester.takeException(), isNull);
    }
  });
}
