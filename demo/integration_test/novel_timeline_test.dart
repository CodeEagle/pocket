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

bool _nearRect(Rect actual, Rect expected, double tolerance) =>
    (actual.left - expected.left).abs() <= tolerance &&
    (actual.top - expected.top).abs() <= tolerance &&
    (actual.width - expected.width).abs() <= tolerance &&
    (actual.height - expected.height).abs() <= tolerance;

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

void main() {
  final binding = IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  binding.reportData = {
    'pocketAcceptance': {
      'required': [
        'novel-timeline-decoded-motion',
        'novel-timeline-lifecycle',
        'novel-timeline-real-audio',
        'novel-timeline-preset-reuse',
        'novel-timeline-normal-store-preserved',
        'novel-timeline-gain-envelope',
        'novel-timeline-gain-replay-exit',
      ],
      'completed': <String>[],
    },
  };
  testWidgets(
    'the shipped ensemble shares one timeline for camera, actor and decoded audio',
    (tester) async {
      final normalSupport = await getApplicationSupportDirectory();
      final normalStore = File(
        '${normalSupport.path}/pocket-platform-data/pocket_platform_data.json',
      );
      final beforeStore = await tester.runAsync(
        () async =>
            await normalStore.exists() ? normalStore.readAsBytes() : null,
      );
      final support = IsolatedNovelSupportDirectory();
      await support.install();
      final captureKey = GlobalKey();
      final systemController = PocketSystemHostController();
      final evidence = await Directory.systemTemp.createTemp(
        'pocket-timeline-evidence-',
      );
      final samples = <Map<String, Object?>>[];
      final observedAudio = <String, Map<String, Object?>>{};
      final gainSamples = <Map<String, Object?>>[];
      PocketAudioPlugin? audio;
      final policy = showcaseNativePolicies['pocket.demo.lantern']!;
      final completed =
          (binding.reportData!['pocketAcceptance']
                  as Map<String, dynamic>)['completed']
              as List<String>;
      void audioFacts() {
        for (var index = 0; index < 4; index++) {
          final snapshot = audio!.snapshotChannel('effect-$index');
          final asset = snapshot['asset'];
          if (asset is String &&
              (snapshot['durationMs'] as num? ?? 0) > 0 &&
              snapshot['playerPresent'] == true) {
            observedAudio[asset] = Map<String, Object?>.from(snapshot);
          }
        }
      }

      Future<void> capture(String name, String background) async {
        final bg = _bounds(tester, 'art/$background.png');
        final actor = _bounds(
          tester,
          'art/mira-${background == 'roof' ? 'hopeful' : 'neutral'}.png',
        );
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
          // Keep the image in driver report data: Android removes the app's
          // private temp directory when flutter drive tears down the profile
          // package, so host-side QA otherwise loses successful PNG captures.
          'pngBase64': base64Encode(png),
        });
      }

      try {
        await tester.pumpWidget(
          RepaintBoundary(
            key: captureKey,
            child: pocketHostApp(
              systemController: systemController,
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
        for (
          var i = 0;
          i < 1000 && !guest.texts(tester).contains('启程 · 开始新的故事');
          i++
        ) {
          await _frame(tester);
        }
        await guest.tapGuest(tester, '灯塔合奏');
        await guest.waitForContaining(tester, '站台的钟声');
        final baselineBg = _bounds(tester, 'art/station.png');
        final baselineActor = _bounds(tester, 'art/mira-neutral.png');
        await capture('initial', 'station');
        await _advance(tester);
        for (
          var i = 0;
          i < 300 &&
              _bounds(tester, 'art/station.png').width <
                  baselineBg.width * 1.06;
          i++
        ) {
          await _frame(tester);
          audioFacts();
        }
        expect(
          _bounds(tester, 'art/station.png').width,
          greaterThan(baselineBg.width * 1.05),
        );
        final movedActor = _bounds(tester, 'art/mira-neutral.png');
        expect(
          [
            (movedActor.left - baselineActor.left).abs(),
            (movedActor.top - baselineActor.top).abs(),
            (movedActor.width - baselineActor.width).abs(),
            (movedActor.height - baselineActor.height).abs(),
          ].reduce(math.max),
          greaterThan(2),
        );
        await capture('moving', 'station');
        completed.add('novel-timeline-decoded-motion');
        final controller = tester
            .widget<PocketView>(guest.activePocketViewFinder())
            .controller!;
        binding.handleAppLifecycleStateChanged(AppLifecycleState.inactive);
        binding.handleAppLifecycleStateChanged(AppLifecycleState.paused);
        await tester.runAsync(
          () => Future<void>.delayed(const Duration(milliseconds: 200)),
        );
        expect(controller.appActive, isFalse);
        final pausedBg = _bounds(tester, 'art/station.png');
        final pausedActor = _bounds(tester, 'art/mira-neutral.png');
        await tester.runAsync(
          () => Future<void>.delayed(const Duration(milliseconds: 250)),
        );
        expect(_bounds(tester, 'art/station.png'), pausedBg);
        expect(_bounds(tester, 'art/mira-neutral.png'), pausedActor);
        binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
        for (
          var i = 0;
          i < 200 && _bounds(tester, 'art/station.png') == pausedBg;
          i++
        ) {
          await _frame(tester);
          audioFacts();
        }
        expect(controller.appActive, isTrue);
        expect(_bounds(tester, 'art/station.png'), isNot(pausedBg));
        await capture('resumed', 'station');
        completed.add('novel-timeline-lifecycle');
        var endpointBg = _bounds(tester, 'art/station.png');
        var endpointActor = _bounds(tester, 'art/mira-neutral.png');
        for (var i = 0; i < 500; i++) {
          await _frame(tester);
          audioFacts();
          endpointBg = _bounds(tester, 'art/station.png');
          endpointActor = _bounds(tester, 'art/mira-neutral.png');
          if (_nearRect(endpointBg, baselineBg, 1) &&
              _nearRect(endpointActor, baselineActor, 1) &&
              observedAudio.keys.any(
                (key) => key.endsWith('relay_click.wav'),
              )) {
            break;
          }
        }
        // Capture the real on-app frame before assertions so endpoint failures
        // retain game pixels in the driver report on Android as well as macOS.
        await capture('finished', 'station');
        samples.add({
          'name': 'station-timeline-endpoint',
          'background': [
            endpointBg.left,
            endpointBg.top,
            endpointBg.width,
            endpointBg.height,
          ],
          'actor': [
            endpointActor.left,
            endpointActor.top,
            endpointActor.width,
            endpointActor.height,
          ],
          'actorOps': _assetFacts(tester, 'art/mira-neutral.png'),
        });
        expect(endpointBg.left, closeTo(baselineBg.left, 1));
        expect(endpointBg.top, closeTo(baselineBg.top, 1));
        expect(endpointBg.width, closeTo(baselineBg.width, 1));
        expect(endpointBg.height, closeTo(baselineBg.height, 1));
        expect(endpointActor.left, closeTo(baselineActor.left, 1));
        expect(endpointActor.top, closeTo(baselineActor.top, 1));
        expect(endpointActor.width, closeTo(baselineActor.width, 1));
        expect(endpointActor.height, closeTo(baselineActor.height, 1));
        for (final cue in ['roof_gust', 'station_bell', 'relay_click']) {
          expect(
            observedAudio.keys.any((key) => key.endsWith('/$cue.wav')),
            isTrue,
            reason: 'Real just_audio transport decoded $cue',
          );
        }
        completed.add('novel-timeline-real-audio');
        await _advance(tester);
        for (var i = 0; i < 200; i++) {
          await _frame(tester);
          audioFacts();
          if (guest.texts(tester).any((text) => text.contains('同一段节拍'))) break;
        }
        await capture('reused-on-roof', 'roof');
        completed.add('novel-timeline-preset-reuse');
        // Continue through the same public replay into its second movement.
        await _advance(tester); // timeline_04
        await _advance(tester); // timeline_05
        await _advance(tester); // timeline_06: named wind with an envelope
        var peaked = false;
        var faded = false;
        var stopped = false;
        var previousPosition = 0;
        final gainTimer = Stopwatch()..start();
        for (var frame = 0; frame < 450; frame++) {
          await _frame(tester);
          final fact = audio!.snapshotChannel('replay-harbor-wind');
          final present = fact['playerPresent'] == true;
          final position = (fact['positionMs'] as num? ?? 0).toInt();
          gainSamples.add({
            ...Map<String, Object?>.from(fact),
            'testFrame': frame,
            'realElapsedMs': gainTimer.elapsedMilliseconds,
            'previousPositionMs': previousPosition,
            'positionDeltaMs': position - previousPosition,
          });
          if (!present) {
            stopped = peaked && faded;
            break;
          }

          final volume = (fact['volume'] as num).toDouble();
          previousPosition = position;
          if (volume > 0.55) peaked = true;
          if (peaked && volume < 0.15) faded = true;
        }
        final activeGainSamples = gainSamples
            .where((fact) => fact['playerPresent'] == true)
            .toList();
        expect(activeGainSamples, isNotEmpty);
        for (final fact in activeGainSamples) {
          expect(fact['channel'], 'replay-harbor-wind');
          expect(fact['asset'], 'audio/roof_gust.wav');
          expect(fact['loop'], isTrue);
          expect(fact['processingState'], 'ready');
          expect(fact['playing'], isTrue);
          expect(fact['durationMs'], greaterThan(0));
          expect(fact['volume'], inInclusiveRange(0.0, 0.7));
        }
        expect(
          peaked,
          isTrue,
          reason: 'Real wind player must rise toward master × gain = .7 × .85',
        );
        expect(
          faded,
          isTrue,
          reason: 'The same player must fade before its authored stop',
        );
        expect(
          stopped,
          isTrue,
          reason: 'Timeline stop must release the named native player',
        );
        expect(gainSamples.last['playerPresent'], isFalse);
        expect(gainSamples.last['playing'], isFalse);
        expect(gainSamples.last['processingState'], 'idle');
        expect(
          activeGainSamples.any((fact) => (fact['positionMs'] as num) > 0),
          isTrue,
          reason:
              'Native playback sampling must show positive position progress',
        );
        completed.add('novel-timeline-gain-envelope');
        await capture('gain-finished', 'roof');
        // A second run exits before completion, exercising replay ownership.
        await _tap(tester, '返回原旅程');
        await guest.waitFor(tester, '启程 · 开始新的故事');
        await guest.tapGuest(tester, '灯塔合奏');
        await guest.waitForContaining(tester, '站台的钟声');
        for (var line = 0; line < 5; line++) {
          await _advance(tester);
        }
        var earlyPlayerReady = false;
        for (var frame = 0; frame < 120; frame++) {
          await _frame(tester);
          final fact = audio!.snapshotChannel('replay-harbor-wind');
          if (fact['playerPresent'] == true &&
              (fact['volume'] as num? ?? 0) > 0.1) {
            earlyPlayerReady = true;
            break;
          }
        }
        expect(earlyPlayerReady, isTrue);
        await _tap(tester, '返回原旅程');
        await guest.waitFor(tester, '启程 · 开始新的故事');
        for (
          var frame = 0;
          frame < 120 &&
              audio!.snapshotChannel('replay-harbor-wind')['playerPresent'] ==
                  true;
          frame++
        ) {
          await _frame(tester);
        }
        expect(
          audio!.snapshotChannel('replay-harbor-wind')['playerPresent'],
          isFalse,
        );
        completed.add('novel-timeline-gain-replay-exit');
        binding.reportData!['novelTimeline'] = {
          'platform': Platform.operatingSystem,
          'samples': samples,
          'audioFacts': observedAudio,
          'gainSamples': gainSamples,
        };
      } finally {
        binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
        final sessions = systemController.instances
            .map((fact) => fact.session)
            .toList();
        await tester.pumpWidget(const SizedBox.shrink());
        await tester.pump();
        // Widget disposal schedules close asynchronously. Await the official
        // session boundary so native IO/storage writes finish before deleting
        // the isolated support directory.
        await tester.runAsync(
          () => Future.wait(sessions.map((session) => session.close())),
        );
        expect(audio?.activeChannelCount ?? 0, 0);
        systemController.dispose();
        await support.restore();
        binding.reportData!['novelTimeline'] ??= {
          'platform': Platform.operatingSystem,
          'samples': samples,
          'audioFacts': observedAudio,
          'gainSamples': gainSamples,
          'factBoundary':
              'tester pointer injection; lifecycle changes use Flutter TestWidgetsFlutterBinding, not human touch or OS backgrounding',
        };
        final afterStore = await tester.runAsync(
          () async =>
              await normalStore.exists() ? normalStore.readAsBytes() : null,
        );
        expect(afterStore, equals(beforeStore));
        completed.add('novel-timeline-normal-store-preserved');
        expect(tester.takeException(), isNull);
      }
    },
  );
}
