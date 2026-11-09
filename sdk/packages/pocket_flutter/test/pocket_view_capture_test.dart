import 'dart:typed_data';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pocket_flutter/pocket_flutter.dart';

final class _CaptureRuntime implements PocketRuntime {
  _CaptureRuntime(this.frameResult);

  final PocketFrame frameResult;

  @override
  PocketFrame eval(String source) => frameResult;

  @override
  PocketFrame load(String source, Uint8List pak) => frameResult;

  @override
  PocketFrame frame(int deltaMilliseconds) => frameResult;

  @override
  bool resizeViewport(double width, double height) => false;

  @override
  void enableAuxiliary(double width, double height) {}

  @override
  void send(Map<String, dynamic> message) {}

  @override
  String? get lastError => null;

  @override
  void dispose() {}
}

PocketFrame _paintedFrame({bool hostSurface = false}) => PocketFrame(
  width: 80,
  height: 64,
  ops: <PocketOp>[
    const PocketRectOp(x: 0, y: 0, width: 40, height: 64, color: 0xffcf4422),
    if (hostSurface)
      const PocketHostSurfaceOp(
        x: 0,
        y: 0,
        width: 80,
        height: 64,
        id: 'host-panel',
        kind: 'application',
        parameters: <String, dynamic>{},
      ),
  ],
  events: const <PocketEvent>[],
);

Future<void> _pumpView(
  WidgetTester tester, {
  required PocketViewController controller,
  required PocketRuntime runtime,
  required bool enableSceneCapture,
  PocketHostSurfaceBuilder? hostSurfaceBuilder,
}) async {
  await tester.pumpWidget(
    MaterialApp(
      home: Align(
        alignment: Alignment.topLeft,
        child: SizedBox(
          width: 80,
          height: 64,
          child: PocketView(
            runtime: runtime,
            controller: controller,
            viewport: const Size(80, 64),
            jsSource: '',
            pakBytes: Uint8List(0),
            inputEnabled: false,
            showDebugFps: false,
            enableSceneCapture: enableSceneCapture,
            hostSurfaceBuilder: hostSurfaceBuilder,
          ),
        ),
      ),
    ),
  );
  await tester.pump();
  await tester.pump();
}

Future<List<int>> _pixel(
  WidgetTester tester,
  PocketViewCapture capture,
  int x,
  int y,
) async {
  final value = await tester.runAsync(() async {
    final codec = await ui.instantiateImageCodec(capture.pngBytes);
    try {
      final frame = await codec.getNextFrame();
      try {
        final data = await frame.image.toByteData(
          format: ui.ImageByteFormat.rawRgba,
        );
        final byteOffset = (y * capture.width + x) * 4;
        return <int>[
          data!.getUint8(byteOffset),
          data.getUint8(byteOffset + 1),
          data.getUint8(byteOffset + 2),
          data.getUint8(byteOffset + 3),
        ];
      } finally {
        frame.image.dispose();
      }
    } finally {
      codec.dispose();
    }
  });
  return value!;
}

Finder _captureBoundaryFinder() => find.byWidgetPredicate(
  (widget) =>
      widget is RepaintBoundary &&
      widget.key is GlobalKey &&
      widget.key.toString().contains('pocket-view-scene-capture'),
);

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  testWidgets('captures the PocketView pixels within requested PNG bounds', (
    tester,
  ) async {
    final controller = PocketViewController();
    final runtime = _CaptureRuntime(_paintedFrame());
    await _pumpView(
      tester,
      controller: controller,
      runtime: runtime,
      enableSceneCapture: true,
    );

    expect(controller.isReady, isTrue);
    expect(_captureBoundaryFinder(), findsOneWidget);
    final customPaintElement = tester.element(find.byType(CustomPaint).first);
    final pendingCapture = controller.captureScene(
      maxWidth: 40,
      maxHeight: 32,
      maxPixels: 800,
    );
    await expectLater(
      controller.captureScene(maxWidth: 40, maxHeight: 32),
      throwsStateError,
    );
    await tester.pump();
    final capture = await tester.runAsync(() => pendingCapture);

    expect(capture, isNotNull);
    final result = capture!;
    expect(result.width, lessThanOrEqualTo(40));
    expect(result.height, lessThanOrEqualTo(32));
    expect(result.width * result.height, lessThanOrEqualTo(800));
    expect(await _pixel(tester, result, 4, 4), <int>[207, 68, 34, 255]);
    // A white MaterialApp backdrop sits outside PocketView. The uncovered
    // half stays transparent in the captured child subtree.
    expect(
      await _pixel(tester, result, result.width - 3, result.height - 3),
      <int>[0, 0, 0, 0],
    );
    expect(
      identical(
        customPaintElement,
        tester.element(find.byType(CustomPaint).first),
      ),
      isTrue,
      reason: "capture must not remount the guest's painted child tree",
    );

    final captureDuringDetach = controller.captureScene(
      maxWidth: 40,
      maxHeight: 32,
    );
    await tester.pumpWidget(const SizedBox.shrink());
    expect(
      await tester.runAsync(() => captureDuringDetach),
      isNull,
      reason: 'readback finishing after unmount must be discarded',
    );
    expect(
      await controller.captureScene(maxWidth: 40, maxHeight: 32),
      isNull,
      reason: 'a detached controller must not expose stale scene pixels',
    );
    runtime.dispose();
  });

  testWidgets('capture opt-in adds only its boundary and guards callers', (
    tester,
  ) async {
    final controller = PocketViewController();
    final runtime = _CaptureRuntime(_paintedFrame());
    await _pumpView(
      tester,
      controller: controller,
      runtime: runtime,
      enableSceneCapture: false,
    );

    expect(_captureBoundaryFinder(), findsNothing);
    expect(
      await controller.captureScene(maxWidth: 40, maxHeight: 32),
      isNull,
      reason: 'the default render path does not allocate a capture layer',
    );
    await expectLater(
      controller.captureScene(maxWidth: 0, maxHeight: 32),
      throwsArgumentError,
    );
    await expectLater(
      controller.captureScene(
        maxWidth: PocketViewController.maxSceneCaptureDimension + 1,
        maxHeight: 32,
      ),
      throwsArgumentError,
    );
    await expectLater(
      controller.captureScene(
        maxWidth: 40,
        maxHeight: 32,
        maxPixels: PocketViewController.maxSceneCapturePixels + 1,
      ),
      throwsArgumentError,
    );

    await tester.pumpWidget(const SizedBox.shrink());
    expect(await controller.captureScene(maxWidth: 40, maxHeight: 32), isNull);
    runtime.dispose();
  });

  testWidgets('rejects unsupported host application surfaces', (tester) async {
    final controller = PocketViewController();
    final runtime = _CaptureRuntime(_paintedFrame(hostSurface: true));
    await _pumpView(
      tester,
      controller: controller,
      runtime: runtime,
      enableSceneCapture: true,
      hostSurfaceBuilder: (_) => const ColoredBox(color: Colors.green),
    );

    final unsupported = controller.captureScene(maxWidth: 40, maxHeight: 32);
    final unsupportedExpectation = expectLater(
      unsupported,
      throwsUnsupportedError,
    );
    await tester.pump();
    await unsupportedExpectation;
    runtime.dispose();
  });
}
