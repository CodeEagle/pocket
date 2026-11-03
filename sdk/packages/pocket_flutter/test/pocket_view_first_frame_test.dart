import 'dart:async';
import 'dart:typed_data';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pocket_flutter/pocket_flutter.dart';

class _FirstFrameRuntime implements PocketRuntime {
  _FirstFrameRuntime(this.initialFrame);

  final PocketFrame initialFrame;
  int frameCalls = 0;
  final List<Map<String, dynamic>> sentMessages = <Map<String, dynamic>>[];

  @override
  PocketFrame eval(String source) => initialFrame;

  @override
  PocketFrame load(String source, Uint8List pak) => initialFrame;

  @override
  PocketFrame frame(int deltaMilliseconds) {
    frameCalls += 1;
    return initialFrame;
  }

  @override
  bool resizeViewport(double width, double height) => false;

  @override
  void enableAuxiliary(double width, double height) {}

  @override
  void send(Map<String, dynamic> message) {
    sentMessages.add(Map<String, dynamic>.from(message));
  }

  @override
  String? get lastError => null;

  @override
  void dispose() {}
}

final class _ResizableFirstFrameRuntime extends _FirstFrameRuntime {
  _ResizableFirstFrameRuntime(super.initialFrame, this.resizedFrame);

  final PocketFrame resizedFrame;
  final List<Size> resizeSizes = <Size>[];

  int get resizeCalls => resizeSizes.length;

  @override
  bool resizeViewport(double width, double height) {
    resizeSizes.add(Size(width, height));
    return true;
  }
}

PocketFrame _imageFrame() {
  final resource = PocketImageResource(
    asset: 'rounded-mask',
    width: 1,
    height: 1,
    psm: 3,
    linear: false,
    pixels: Uint8List.fromList(<int>[255, 255, 255, 255]),
  );
  return PocketFrame(
    width: 320,
    height: 480,
    ops: const <PocketOp>[
      PocketRectOp(x: 0, y: 0, width: 320, height: 480, color: 0xff101827),
      PocketImageOp(
        x: 20,
        y: 20,
        width: 100,
        height: 80,
        asset: 'rounded-mask',
      ),
    ],
    events: const <PocketEvent>[],
    resources: <PocketImageResource>[resource],
  );
}

PocketFrame _resizedImageFrame() {
  final resource = PocketImageResource(
    asset: 'resized-mask',
    width: 1,
    height: 1,
    psm: 3,
    linear: false,
    pixels: Uint8List.fromList(<int>[255, 255, 255, 255]),
  );
  return PocketFrame(
    width: 322,
    height: 480,
    ops: const <PocketOp>[
      PocketRectOp(x: 0, y: 0, width: 322, height: 480, color: 0xff101827),
      PocketImageOp(
        x: 20,
        y: 20,
        width: 100,
        height: 80,
        asset: 'resized-mask',
      ),
    ],
    events: const <PocketEvent>[],
    resources: <PocketImageResource>[resource],
    releasedResources: const <String>['rounded-mask'],
  );
}

Widget _host(
  PocketRuntime runtime, {
  required PocketImageResourceDecoder decoder,
  PocketViewController? controller,
  ValueChanged<Object>? onError,
  VoidCallback? onReady,
}) {
  return MaterialApp(
    home: SizedBox(
      width: 320,
      height: 480,
      child: PocketView(
        controller: controller,
        runtime: runtime,
        jsSource: '',
        pakBytes: Uint8List(0),
        showDebugFps: false,
        imageResourceDecoder: decoder,
        onError: onError,
        onReady: (_) => onReady?.call(),
      ),
    ),
  );
}

Widget _selfOwnedHost(
  double width, {
  required PocketImageResourceDecoder decoder,
  ValueChanged<Object>? onError,
  VoidCallback? onReady,
}) {
  return MaterialApp(
    home: Align(
      alignment: Alignment.topLeft,
      child: SizedBox(
        width: width,
        height: 480,
        child: PocketView(
          jsSource: '',
          pakBytes: Uint8List(0),
          showDebugFps: false,
          imageResourceDecoder: decoder,
          onError: onError,
          onReady: (_) => onReady?.call(),
        ),
      ),
    ),
  );
}

Future<ui.Image> _onePixelImage(WidgetTester tester) async {
  final image = await tester.runAsync(() async {
    final recorder = ui.PictureRecorder();
    final canvas = ui.Canvas(recorder);
    canvas.drawColor(const ui.Color(0xffffffff), ui.BlendMode.src);
    final picture = recorder.endRecording();
    final result = await picture.toImage(1, 1);
    picture.dispose();
    return result;
  });
  return image!;
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  testWidgets(
    'does not expose the first image draw op while its resource is pending',
    (tester) async {
      final decode = Completer<ui.Image>();
      var ready = false;
      final runtime = _FirstFrameRuntime(_imageFrame());
      await tester.pumpWidget(
        _host(
          runtime,
          decoder: (_) => decode.future,
          onReady: () => ready = true,
        ),
      );
      await tester.pump();

      // This is the negative check for the old eager-publish behavior: the
      // old implementation hid the loading surface and called onReady before
      // the decoder completed, so this assertion must fail on that version.
      expect(find.byType(CircularProgressIndicator), findsOneWidget);
      expect(ready, isFalse);

      decode.complete(await _onePixelImage(tester));
      await tester.runAsync(() async => decode.future);
      await tester.pump();
      await tester.pump();

      expect(find.byType(CircularProgressIndicator), findsNothing);
      expect(ready, isTrue);
    },
  );

  testWidgets('turns a first-frame decode failure into an error surface', (
    tester,
  ) async {
    final errors = <Object>[];
    var ready = false;
    final runtime = _FirstFrameRuntime(_imageFrame());
    await tester.pumpWidget(
      _host(
        runtime,
        decoder: (_) => Future<ui.Image>.error(StateError('decode failed')),
        onError: errors.add,
        onReady: () => ready = true,
      ),
    );
    await tester.pump();
    await tester.pump();

    expect(ready, isFalse);
    expect(errors, isNotEmpty);
    expect(find.textContaining('PocketJS runtime unavailable'), findsOneWidget);
    expect(find.byType(CircularProgressIndicator), findsNothing);
  });

  testWidgets('bounds a first-frame decode that never completes', (
    tester,
  ) async {
    debugPocketFirstFrameResourceTimeoutOverride = const Duration(
      milliseconds: 10,
    );
    addTearDown(() => debugPocketFirstFrameResourceTimeoutOverride = null);
    final decode = Completer<ui.Image>();
    final errors = <Object>[];
    final runtime = _FirstFrameRuntime(_imageFrame());
    await tester.pumpWidget(
      _host(runtime, decoder: (_) => decode.future, onError: errors.add),
    );
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 11));
    await tester.pump();

    expect(errors, isNotEmpty);
    expect(find.textContaining('PocketJS runtime unavailable'), findsOneWidget);
    expect(find.byType(CircularProgressIndicator), findsNothing);
  });

  testWidgets('late decode after unmount is cancelled without publishing', (
    tester,
  ) async {
    final decode = Completer<ui.Image>();
    var ready = false;
    final runtime = _FirstFrameRuntime(_imageFrame());
    await tester.pumpWidget(
      _host(
        runtime,
        decoder: (_) => decode.future,
        onReady: () => ready = true,
      ),
    );
    await tester.pump();
    await tester.pumpWidget(const SizedBox.shrink());

    decode.complete(await _onePixelImage(tester));
    await tester.runAsync(() async => decode.future);
    await tester.pump();

    expect(ready, isFalse);
    expect(find.byType(PocketView), findsNothing);
  });

  testWidgets(
    'coalesces a resize until both first and resized image resources are ready',
    (tester) async {
      final firstDecode = Completer<ui.Image>();
      final resizedDecode = Completer<ui.Image>();
      final errors = <Object>[];
      var ready = false;
      final initialFrame = _imageFrame();
      final resizedFrame = _resizedImageFrame();
      final runtime = _ResizableFirstFrameRuntime(initialFrame, resizedFrame);
      final previousFactory = debugPocketSelfOwnedRuntimeFactory;
      final previousDelta = debugPocketFrameDeltaAtOverride;
      addTearDown(() {
        debugPocketSelfOwnedRuntimeFactory = previousFactory;
        debugPocketFrameDeltaAtOverride = previousDelta;
      });
      debugPocketSelfOwnedRuntimeFactory = (_) => runtime;
      debugPocketFrameDeltaAtOverride = (current, _) {
        final resizable = current as _ResizableFirstFrameRuntime;
        return resizable.resizeCalls == 0 ? null : resizable.resizedFrame;
      };

      Future<ui.Image> decode(PocketImageResource resource) {
        return resource.asset == 'rounded-mask'
            ? firstDecode.future
            : resizedDecode.future;
      }

      await tester.pumpWidget(
        _selfOwnedHost(
          320,
          decoder: decode,
          onError: errors.add,
          onReady: () => ready = true,
        ),
      );
      await tester.pump();
      expect(runtime.resizeCalls, 0);

      await tester.pumpWidget(
        _selfOwnedHost(
          321,
          decoder: decode,
          onError: errors.add,
          onReady: () => ready = true,
        ),
      );
      await tester.pump();
      expect(runtime.resizeCalls, 0);

      await tester.pumpWidget(
        _selfOwnedHost(
          322,
          decoder: decode,
          onError: errors.add,
          onReady: () => ready = true,
        ),
      );
      await tester.pump();
      expect(runtime.resizeCalls, 0);

      firstDecode.complete(await _onePixelImage(tester));
      await tester.runAsync(() async => firstDecode.future);
      await tester.pump();
      await tester.pump();

      expect(runtime.resizeCalls, 1);
      expect(runtime.resizeSizes.single, const Size(322, 480));
      expect(ready, isFalse);
      expect(find.byType(CircularProgressIndicator), findsOneWidget);

      resizedDecode.complete(await _onePixelImage(tester));
      await tester.runAsync(() async => resizedDecode.future);
      await tester.pump();
      await tester.pump();

      expect(errors, isEmpty);
      expect(ready, isTrue);
      expect(find.byType(CircularProgressIndicator), findsNothing);
    },
  );

  testWidgets(
    'lifecycle resume and controller messages during first image decode do not create a second ticker or advance the guest early',
    (tester) async {
      final decode = Completer<ui.Image>();
      final errors = <Object>[];
      var ready = false;
      final controller = PocketViewController();
      final runtime = _FirstFrameRuntime(_imageFrame());
      await tester.pumpWidget(
        _host(
          runtime,
          controller: controller,
          decoder: (_) => decode.future,
          onError: errors.add,
          onReady: () => ready = true,
        ),
      );
      await tester.pump();
      expect(ready, isFalse);

      // Queue controller work while the first-frame resource barrier is active.
      expect(controller.send(method: 'during-barrier', params: const {'seq': 1}), isTrue);
      expect(runtime.sentMessages, isEmpty);
      expect(runtime.frameCalls, 0);

      // Normal OS lifecycle and controller activity transitions during decoding
      // must not create a premature ticker or advance the guest before ready.
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.inactive);
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
      controller.setAppActive(false);
      controller.setAppActive(true);
      await tester.pump(const Duration(milliseconds: 16));
      expect(errors, isEmpty);
      expect(ready, isFalse);
      expect(runtime.frameCalls, 0);
      expect(runtime.sentMessages, isEmpty);

      decode.complete(await _onePixelImage(tester));
      await tester.runAsync(() async => decode.future);
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 16));

      expect(errors, isEmpty, reason: 'normal OS lifecycle must not fail startup');
      expect(ready, isTrue);
      expect(find.byType(CircularProgressIndicator), findsNothing);
      expect(
        runtime.sentMessages.any((message) => message['name'] == 'during-barrier'),
        isTrue,
      );
      expect(runtime.frameCalls, greaterThan(0));
    },
  );
}
