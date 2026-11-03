import 'dart:async';
import 'dart:typed_data';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pocket_flutter/pocket_flutter.dart';

final class _InvalidationRuntime
    implements PocketRuntime, PocketRuntimeScheduling {
  _InvalidationRuntime({this.initialEvent});

  final PocketEvent? initialEvent;
  final List<PocketEvent> _pendingEvents = <PocketEvent>[];
  bool _sentInitial = false;
  List<PocketOp> ops = const <PocketOp>[
    PocketRectOp(x: 0, y: 0, width: 320, height: 480, color: 0xff101827),
  ];
  PocketSurfaceFrame? auxiliary;
  List<PocketImageResource> resources = const <PocketImageResource>[];
  List<String> releasedResources = const <String>[];

  void enqueue(PocketEvent event) => _pendingEvents.add(event);

  @override
  double get nextWakeDelayMilliseconds => -1;

  PocketFrame _nextFrame() {
    final events = <PocketEvent>[];
    if (!_sentInitial) {
      _sentInitial = true;
      final initial = initialEvent;
      if (initial != null) events.add(initial);
    }
    events.addAll(_pendingEvents);
    _pendingEvents.clear();
    final currentAuxiliary = auxiliary;
    return PocketFrame(
      width: 320,
      height: 480,
      // Native frame decoding returns fresh op objects. Keep the test honest
      // about structural equality rather than allowing list identity to win.
      ops: List<PocketOp>.of(ops, growable: false),
      events: events,
      resources: List<PocketImageResource>.of(resources, growable: false),
      releasedResources: List<String>.of(releasedResources, growable: false),
      auxiliary: currentAuxiliary == null
          ? null
          : PocketSurfaceFrame(
              width: currentAuxiliary.width,
              height: currentAuxiliary.height,
              ops: List<PocketOp>.of(currentAuxiliary.ops, growable: false),
            ),
    );
  }

  @override
  PocketFrame eval(String source) => _nextFrame();

  @override
  PocketFrame load(String source, Uint8List pak) => _nextFrame();

  @override
  PocketFrame frame(int deltaMilliseconds) => _nextFrame();

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

PocketEvent _event(String method, Map<String, dynamic> params) =>
    PocketEvent(id: 'event-$method', method: method, params: params);

Map<String, dynamic> _open(String id) => <String, dynamic>{
  'id': id,
  'editingSession': 'session-$id',
  'rect': <String, double>{'x': 20, 'y': 40, 'w': 180, 'h': 42},
  'text': 'hello',
  'selectionBase': 5,
  'selectionExtent': 5,
};

Map<String, dynamic> _update(
  String id, {
  String? text,
  double? x,
}) => <String, dynamic>{
  'id': id,
  'editingSession': 'session-$id',
  if (text != null) 'text': text,
  if (x != null) 'rect': <String, double>{'x': x, 'y': 40, 'w': 180, 'h': 42},
};

PocketHostSurfaceOp _applicationSurface({
  required bool focused,
  required int radius,
}) => PocketHostSurfaceOp(
  x: 40,
  y: 60,
  width: 120,
  height: 80,
  id: 'app-7',
  kind: 'application',
  parameters: <String, dynamic>{'radius': radius},
  surfaceHandle: 7,
  focused: focused,
);

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  Future<dynamic> mount(
    WidgetTester tester,
    _InvalidationRuntime runtime,
    PocketViewController controller, {
    PocketImageResourceDecoder? imageResourceDecoder,
    bool showDebugFps = true,
  }) async {
    await tester.pumpWidget(
      MaterialApp(
        home: Align(
          alignment: Alignment.topLeft,
          child: SizedBox(
            width: 320,
            height: 480,
            child: PocketView(
              controller: controller,
              runtime: runtime,
              jsSource: '',
              pakBytes: Uint8List(0),
              imageResourceDecoder: imageResourceDecoder,
              showDebugFps: showDebugFps,
            ),
          ),
        ),
      ),
    );
    await tester.pump();
    await tester.pump();
    return tester.state(find.byType(PocketView));
  }

  testWidgets('editor invalidation does not rebuild the retained scene', (
    tester,
  ) async {
    final runtime = _InvalidationRuntime(
      initialEvent: _event('textInput.open', _open('field-a')),
    );
    final controller = PocketViewController();
    final state = await mount(tester, runtime, controller);
    final dynamic viewState = state;
    final sceneRevision = viewState.debugSceneRevision as int;
    final sceneBuilds = viewState.debugSceneBuildCount as int;
    final editorBuilds = viewState.debugEditorBuildCount as int;
    final editableFinder = find.byType(EditableText);
    final editableElement = tester.element(editableFinder);

    runtime.enqueue(_event('textInput.update', _update('field-a', x: 28)));
    controller.notifyWork();
    await tester.pump(const Duration(milliseconds: 16));

    expect(viewState.debugSceneRevision, sceneRevision);
    expect(viewState.debugSceneBuildCount, sceneBuilds);
    expect(viewState.debugEditorRevision, greaterThan(0));
    expect(viewState.debugEditorBuildCount, editorBuilds + 1);
    expect(identical(tester.element(editableFinder), editableElement), isTrue);

    final editorRevisionAfterRect = viewState.debugEditorRevision as int;
    final editorBuildsAfterRect = viewState.debugEditorBuildCount as int;
    runtime.enqueue(
      _event('textInput.update', <String, dynamic>{
        'id': 'field-a',
        'editingSession': 'session-field-a',
        'fontSize': 18,
      }),
    );
    controller.notifyWork();
    await tester.pump(const Duration(milliseconds: 16));

    expect(viewState.debugSceneRevision, sceneRevision);
    expect(viewState.debugSceneBuildCount, sceneBuilds);
    expect(viewState.debugEditorRevision, editorRevisionAfterRect + 1);
    expect(viewState.debugEditorBuildCount, editorBuildsAfterRect + 1);

    final editorRevision = viewState.debugEditorRevision as int;
    final editorBuildsAfterStyle = viewState.debugEditorBuildCount as int;
    runtime.enqueue(
      _event('textInput.update', _update('field-a', text: 'hello world')),
    );
    controller.notifyWork();
    await tester.pump(const Duration(milliseconds: 16));

    // Value-only JS updates flow through the existing controller and do not
    // invalidate either widget subtree.
    expect(viewState.debugSceneRevision, sceneRevision);
    expect(viewState.debugSceneBuildCount, sceneBuilds);
    expect(viewState.debugEditorRevision, editorRevision);
    expect(viewState.debugEditorBuildCount, editorBuildsAfterStyle);
    expect(find.byType(TextField), findsOneWidget);
    expect(
      tester.widget<TextField>(find.byType(TextField)).controller!.text,
      'hello world',
    );

    runtime.enqueue(
      _event('textInput.close', <String, dynamic>{
        'id': 'field-a',
        'editingSession': 'session-field-a',
      }),
    );
    runtime.enqueue(_event('textInput.open', _open('field-b')));
    controller.notifyWork();
    await tester.pump(const Duration(milliseconds: 16));

    // Close + open in one guest frame publish one editor invalidation.
    expect(viewState.debugSceneRevision, sceneRevision);
    expect(viewState.debugSceneBuildCount, sceneBuilds);
    expect(viewState.debugEditorRevision, editorRevision + 1);
    expect(
      find.byKey(const ValueKey<String>('pocket-text-input-field-b')),
      findsOneWidget,
    );
  });

  testWidgets('visual frame changes still invalidate the scene', (
    tester,
  ) async {
    final runtime = _InvalidationRuntime(
      initialEvent: _event('textInput.open', _open('field-a')),
    );
    final controller = PocketViewController();
    final state = await mount(tester, runtime, controller);
    final dynamic viewState = state;
    final sceneRevision = viewState.debugSceneRevision as int;
    final sceneBuilds = viewState.debugSceneBuildCount as int;

    PocketCanvasPainter.resetPaintInvocationCount();
    runtime.ops = const <PocketOp>[
      PocketRectOp(x: 0, y: 0, width: 320, height: 480, color: 0xff45a070),
    ];
    controller.notifyWork();
    await tester.pump(const Duration(milliseconds: 16));

    expect(viewState.debugSceneRevision, sceneRevision + 1);
    expect(viewState.debugSceneBuildCount, sceneBuilds + 1);
    expect(PocketCanvasPainter.paintInvocationCount, greaterThan(0));
  });

  testWidgets('structurally equal cloned ops retain the scene', (tester) async {
    final runtime = _InvalidationRuntime();
    final controller = PocketViewController();
    final state = await mount(tester, runtime, controller);
    final dynamic viewState = state;
    final sceneRevision = viewState.debugSceneRevision as int;
    final sceneBuilds = viewState.debugSceneBuildCount as int;

    // _nextFrame clones the list and every frame object, so this exercises
    // structural equality rather than an accidental identical(list) fast path.
    PocketCanvasPainter.resetPaintInvocationCount();
    controller.notifyWork();
    await tester.pump(const Duration(milliseconds: 16));

    expect(viewState.debugSceneRevision, sceneRevision);
    expect(viewState.debugSceneBuildCount, sceneBuilds);
    expect(PocketCanvasPainter.paintInvocationCount, 0);
  });

  testWidgets('auxiliary surface changes invalidate and render the scene', (
    tester,
  ) async {
    final runtime = _InvalidationRuntime();
    final controller = PocketViewController();
    final state = await mount(tester, runtime, controller);
    final dynamic viewState = state;
    final sceneRevision = viewState.debugSceneRevision as int;
    final sceneBuilds = viewState.debugSceneBuildCount as int;

    runtime.auxiliary = const PocketSurfaceFrame(
      width: 160,
      height: 120,
      ops: <PocketOp>[
        PocketRectOp(x: 0, y: 0, width: 160, height: 120, color: 0xff45a070),
      ],
    );
    controller.notifyWork();
    await tester.pump(const Duration(milliseconds: 16));

    expect(viewState.debugSceneRevision, sceneRevision + 1);
    expect(viewState.debugSceneBuildCount, sceneBuilds + 1);
    expect(
      find.byKey(const ValueKey<String>('pocket-surface-1')),
      findsOneWidget,
    );
    expect(
      tester.getSize(find.byKey(const ValueKey<String>('pocket-surface-1'))),
      const Size(320, 240),
    );
  });

  testWidgets('host surface parameter and focus changes refresh the scene', (
    tester,
  ) async {
    final runtime = _InvalidationRuntime();
    runtime.ops = <PocketOp>[
      const PocketRectOp(
        x: 0,
        y: 0,
        width: 320,
        height: 480,
        color: 0xff101827,
      ),
      _applicationSurface(focused: false, radius: 4),
    ];
    final controller = PocketViewController();
    final slots = <PocketCompositorSlot>[];
    await tester.pumpWidget(
      MaterialApp(
        home: Align(
          alignment: Alignment.topLeft,
          child: SizedBox(
            width: 320,
            height: 480,
            child: PocketView(
              controller: controller,
              runtime: runtime,
              jsSource: '',
              pakBytes: Uint8List(0),
              hostSurfaceResidents: const <int>{7},
              hostSurfaceBuilder: (slot) {
                slots.add(slot);
                return const SizedBox.shrink();
              },
            ),
          ),
        ),
      ),
    );
    await tester.pump();
    await tester.pump();
    final dynamic viewState = tester.state(find.byType(PocketView));
    final sceneRevision = viewState.debugSceneRevision as int;
    final sceneBuilds = viewState.debugSceneBuildCount as int;
    expect(slots.last.focused, isFalse);

    runtime.ops = <PocketOp>[
      const PocketRectOp(
        x: 0,
        y: 0,
        width: 320,
        height: 480,
        color: 0xff101827,
      ),
      _applicationSurface(focused: true, radius: 8),
    ];
    controller.notifyWork();
    await tester.pump(const Duration(milliseconds: 16));

    expect(viewState.debugSceneRevision, sceneRevision + 1);
    expect(viewState.debugSceneBuildCount, sceneBuilds + 1);
    expect(slots.last.focused, isTrue);
  });

  testWidgets('resource decode completion and release refresh the scene', (
    tester,
  ) async {
    final resource = PocketImageResource(
      asset: 'pixel',
      width: 1,
      height: 1,
      psm: 3,
      linear: false,
      pixels: Uint8List.fromList(<int>[255, 0, 0, 255]),
    );
    final runtime = _InvalidationRuntime();
    runtime.ops = const <PocketOp>[
      PocketImageOp(x: 0, y: 0, width: 1, height: 1, asset: 'pixel'),
    ];
    runtime.resources = <PocketImageResource>[resource];
    final decoder = Completer<ui.Image>();
    var decodeCount = 0;
    final controller = PocketViewController();
    final state = await mount(
      tester,
      runtime,
      controller,
      imageResourceDecoder: (requested) {
        expect(requested, same(resource));
        decodeCount++;
        return decoder.future;
      },
    );
    final dynamic viewState = state;
    final sceneRevisionBeforeDecode = viewState.debugSceneRevision as int;
    final sceneBuildsBeforeDecode = viewState.debugSceneBuildCount as int;
    expect(decodeCount, 1);

    final image = (await tester.runAsync(() async {
      final recorder = ui.PictureRecorder();
      final canvas = ui.Canvas(recorder);
      canvas.drawColor(const ui.Color(0xffff0000), ui.BlendMode.src);
      final picture = recorder.endRecording();
      final result = await picture.toImage(1, 1);
      picture.dispose();
      return result;
    }))!;
    decoder.complete(image);
    // The decoder continuation completes in the async zone; the first pump
    // delivers its notifier and the second pump performs the retained-scene
    // build that the notifier requests.
    await tester.runAsync(() async {
      await decoder.future;
    });
    await tester.pump();
    await tester.pump();

    expect(
      viewState.debugSceneRevision,
      greaterThan(sceneRevisionBeforeDecode),
    );
    expect(
      viewState.debugSceneBuildCount,
      greaterThan(sceneBuildsBeforeDecode),
    );

    final sceneRevisionBeforeRelease = viewState.debugSceneRevision as int;
    final sceneBuildsBeforeRelease = viewState.debugSceneBuildCount as int;
    runtime.resources = const <PocketImageResource>[];
    runtime.releasedResources = const <String>['pixel'];
    controller.notifyWork();
    await tester.pump(const Duration(milliseconds: 16));

    expect(
      viewState.debugSceneRevision,
      greaterThan(sceneRevisionBeforeRelease),
    );
    expect(
      viewState.debugSceneBuildCount,
      greaterThan(sceneBuildsBeforeRelease),
    );
  });

  testWidgets('dense scene rebuild preserves the editor element', (
    tester,
  ) async {
    final runtime = _InvalidationRuntime(
      initialEvent: _event('textInput.open', _open('field-a')),
    );
    final controller = PocketViewController();
    final state = await mount(tester, runtime, controller);
    final dynamic viewState = state;
    final fieldFinder = find.byKey(
      const ValueKey<String>('pocket-text-input-field-a'),
    );
    final before = tester.widget<TextField>(fieldFinder);
    final textController = before.controller;
    final focusNode = before.focusNode;

    runtime.ops = List<PocketOp>.generate(
      33,
      (index) => PocketRectOp(
        x: index.toDouble(),
        y: 0,
        width: 1,
        height: 1,
        color: 0xff101827,
      ),
      growable: false,
    );
    final sceneRevision = viewState.debugSceneRevision as int;
    controller.notifyWork();
    await tester.pump(const Duration(milliseconds: 16));

    expect(viewState.debugSceneRevision, sceneRevision + 1);
    final after = tester.widget<TextField>(fieldFinder);
    expect(identical(after.controller, textController), isTrue);
    expect(identical(after.focusNode, focusNode), isTrue);
  });

  testWidgets('DPR metrics refresh the retained painter exactly when needed', (
    tester,
  ) async {
    addTearDown(tester.view.reset);
    tester.view.devicePixelRatio = 1;
    tester.view.physicalSize = const Size(320, 480);

    final runtime = _InvalidationRuntime();
    final controller = PocketViewController();
    final state = await mount(tester, runtime, controller, showDebugFps: false);
    final dynamic viewState = state;
    final painterFinder = find.byWidgetPredicate(
      (widget) =>
          widget is CustomPaint && widget.painter is PocketCanvasPainter,
    );
    PocketCanvasPainter currentPainter() =>
        (tester.widget<CustomPaint>(painterFinder).painter!
            as PocketCanvasPainter);

    final initialSceneBuilds = viewState.debugSceneBuildCount as int;
    expect(currentPainter().devicePixelRatio, 1);

    // A real view-metrics change that leaves DPR unchanged must not invalidate
    // the retained scene. Keep the PocketView host fixed at 320x480 so this
    // exercises metrics handling rather than a host layout change.
    tester.view.physicalSize = const Size(321, 481);
    await tester.pump();
    expect(viewState.debugSceneBuildCount, initialSceneBuilds);
    expect(currentPainter().devicePixelRatio, 1);

    // Change physical pixels with DPR so the logical view remains 320x480.
    // The painter is rebuilt from the same logical frame with the new DPR.
    tester.view.devicePixelRatio = 2;
    tester.view.physicalSize = const Size(640, 960);
    await tester.pump();
    await tester.pump();
    final sceneBuildsAfterDpr = viewState.debugSceneBuildCount as int;
    expect(sceneBuildsAfterDpr, greaterThan(initialSceneBuilds));
    expect(currentPainter().devicePixelRatio, 2);

    // More metrics at the already-captured DPR must not cause another scene
    // build, even though the FlutterView's physical bounds changed again.
    tester.view.physicalSize = const Size(642, 962);
    await tester.pump();
    expect(viewState.debugSceneBuildCount, sceneBuildsAfterDpr);
    expect(currentPainter().devicePixelRatio, 2);
  });

  testWidgets(
    'unavailable runtime resize invalidates the retained scene out of OverflowBox',
    (tester) async {
      addTearDown(() {
        debugPocketSelfOwnedRuntimeFactory = null;
      });
      final runtime = _InvalidationRuntime();
      debugPocketSelfOwnedRuntimeFactory = (_) => runtime;

      await tester.pumpWidget(
        MaterialApp(
          home: Align(
            alignment: Alignment.topLeft,
            child: SizedBox(
              width: 320,
              height: 480,
              child: PocketView(
                jsSource: '',
                pakBytes: Uint8List(0),
                showDebugFps: false,
              ),
            ),
          ),
        ),
      );
      await tester.pump();
      await tester.pump();

      final dynamic viewState = tester.state(find.byType(PocketView));
      final sceneRevision = viewState.debugSceneRevision as int;
      final sceneBuilds = viewState.debugSceneBuildCount as int;
      expect(find.byType(OverflowBox), findsOneWidget);
      expect(
        tester.getSize(find.byKey(const ValueKey<String>('pocket-surface-0'))),
        const Size(320, 480),
      );

      await tester.pumpWidget(
        MaterialApp(
          home: Align(
            alignment: Alignment.topLeft,
            child: SizedBox(
              width: 160,
              height: 240,
              child: PocketView(
                jsSource: '',
                pakBytes: Uint8List(0),
                showDebugFps: false,
              ),
            ),
          ),
        ),
      );
      await tester.pump();
      await tester.pump();

      expect(viewState.debugSceneRevision, greaterThan(sceneRevision));
      expect(viewState.debugSceneBuildCount, greaterThan(sceneBuilds));
      expect(find.byType(OverflowBox), findsNothing);
      expect(
        tester.getSize(find.byKey(const ValueKey<String>('pocket-surface-0'))),
        const Size(160, 240),
      );
    },
  );
}
