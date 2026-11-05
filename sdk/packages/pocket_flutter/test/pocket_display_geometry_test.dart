import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pocket_flutter/pocket_flutter.dart';

final class _GeometryRuntime implements PocketRuntime {
  final List<Map<String, dynamic>> messages = <Map<String, dynamic>>[];

  final PocketFrame _frame = const PocketFrame(
    width: 320,
    height: 480,
    ops: <PocketOp>[
      PocketRectOp(x: 0, y: 0, width: 320, height: 480, color: 0xff101827),
    ],
    events: <PocketEvent>[],
  );

  @override
  PocketFrame eval(String source) => _frame;

  @override
  PocketFrame load(String source, Uint8List pak) => _frame;

  @override
  PocketFrame frame(int deltaMilliseconds) => _frame;

  @override
  bool resizeViewport(double width, double height) => false;

  @override
  void enableAuxiliary(double width, double height) {}

  @override
  void send(Map<String, dynamic> message) {
    messages.add(Map<String, dynamic>.from(message));
  }

  @override
  String? get lastError => null;

  @override
  void dispose() {}
}

final class _FakeGeometrySource implements PocketDisplayGeometrySource {
  _FakeGeometrySource(this.snapshot);

  PocketDisplayGeometrySnapshot snapshot;
  PocketDisplayGeometryUpdate? onUpdate;
  bool stopped = false;

  @override
  Future<PocketDisplayGeometrySnapshot> start({
    PocketDisplayGeometryUpdate? onUpdate,
  }) async {
    this.onUpdate = onUpdate;
    return snapshot;
  }

  @override
  Future<void> stop({PocketDisplayGeometryUpdate? onUpdate}) async {
    stopped = true;
    if (identical(onUpdate, this.onUpdate)) this.onUpdate = null;
  }

  void emit(PocketDisplayGeometrySnapshot next) {
    snapshot = next;
    onUpdate?.call(next);
  }
}

Map<String, dynamic> _lastViewport(_GeometryRuntime runtime) {
  return Map<String, dynamic>.from(
    runtime.messages.lastWhere(
          (message) => message['name'] == 'display.viewport',
        )['payload']
        as Map,
  );
}

int _viewportMessageCount(_GeometryRuntime runtime) {
  return runtime.messages
      .where((message) => message['name'] == 'display.viewport')
      .length;
}

Map<String, dynamic> _lastAccessibility(_GeometryRuntime runtime) {
  return Map<String, dynamic>.from(
    runtime.messages.lastWhere(
          (message) => message['name'] == 'accessibility.preferences',
        )['payload']
        as Map,
  );
}

Widget _view(
  _GeometryRuntime runtime, {
  PocketDisplayGeometrySource? displayGeometry,
}) {
  return MaterialApp(
    home: Align(
      alignment: Alignment.topLeft,
      child: Padding(
        padding: const EdgeInsets.only(left: 20, top: 10),
        child: SizedBox(
          width: 320,
          height: 480,
          child: PocketView(
            runtime: runtime,
            jsSource: '',
            pakBytes: Uint8List(0),
            displayGeometry: displayGeometry,
            showDebugFps: false,
          ),
        ),
      ),
    ),
  );
}

void main() {
  test('parses the optional native reduce-transparency fact', () {
    final enabled = PocketDisplayGeometrySnapshot.fromDynamic(<String, dynamic>{
      'supported': false,
      'reduceTransparency': true,
    });
    expect(enabled.reduceTransparency, isTrue);

    final unknown = PocketDisplayGeometrySnapshot.fromDynamic(<String, dynamic>{
      'supported': false,
      'reduceTransparency': 'unavailable',
    });
    expect(unknown.reduceTransparency, isNull);
  });

  testWidgets('maps reserved regions into an offset guest canvas', (
    tester,
  ) async {
    addTearDown(tester.view.reset);
    tester.view.devicePixelRatio = 1;
    tester.view.physicalSize = const Size(400, 520);
    final source = _FakeGeometrySource(
      PocketDisplayGeometrySnapshot(
        supported: true,
        regions: <PocketDisplayRegion>[
          PocketDisplayRegion(
            id: 'division-1',
            kind: 'division',
            frame: const Rect.fromLTWH(25, 20, 50, 100),
            margins: const EdgeInsets.fromLTRB(5, 2, 3, 4),
            active: true,
          ),
        ],
      ),
    );
    final runtime = _GeometryRuntime();
    await tester.pumpWidget(_view(runtime, displayGeometry: source));
    await tester.pump();

    final payload = _lastViewport(runtime);
    expect(payload['reservedRegions'], <Map<String, dynamic>>[
      <String, dynamic>{
        'id': 'division-1',
        'kind': 'division',
        'frame': <String, double>{
          'left': 5,
          'top': 10,
          'width': 50,
          'height': 100,
        },
        'margins': <String, double>{
          'top': 2,
          'right': 3,
          'bottom': 4,
          'left': 5,
        },
        'active': true,
      },
    ]);

    source.emit(
      const PocketDisplayGeometrySnapshot(
        supported: true,
        regions: <PocketDisplayRegion>[],
      ),
    );
    await tester.pump();
    expect(_lastViewport(runtime)['reservedRegions'], isEmpty);
    await tester.pumpWidget(const SizedBox.shrink());
    await tester.pump();
    expect(source.stopped, isTrue);
  });

  testWidgets('clips a platform region to the host canvas', (tester) async {
    addTearDown(tester.view.reset);
    tester.view.devicePixelRatio = 1;
    tester.view.physicalSize = const Size(400, 520);
    final source = _FakeGeometrySource(
      PocketDisplayGeometrySnapshot(
        supported: true,
        regions: <PocketDisplayRegion>[
          PocketDisplayRegion(
            id: 'camera',
            kind: 'occlusion',
            frame: const Rect.fromLTWH(0, 0, 100, 100),
            margins: EdgeInsets.zero,
            active: true,
          ),
        ],
      ),
    );
    final runtime = _GeometryRuntime();
    await tester.pumpWidget(_view(runtime, displayGeometry: source));
    await tester.pump();

    final region =
        (_lastViewport(runtime)['reservedRegions'] as List).single as Map;
    expect(region['frame'], <String, double>{
      'left': 0,
      'top': 0,
      'width': 80,
      'height': 90,
    });
  });

  testWidgets('missing native geometry channel is an empty safe fallback', (
    tester,
  ) async {
    addTearDown(tester.view.reset);
    tester.view.devicePixelRatio = 1;
    tester.view.physicalSize = const Size(400, 520);
    final runtime = _GeometryRuntime();
    await tester.pumpWidget(_view(runtime));
    await tester.pump();

    expect(_lastViewport(runtime)['reservedRegions'], isEmpty);
    expect(tester.takeException(), isNull);
  });

  testWidgets(
    'replays native reduce-transparency changes on the preference lane',
    (tester) async {
      final source = _FakeGeometrySource(
        const PocketDisplayGeometrySnapshot(reduceTransparency: true),
      );
      final runtime = _GeometryRuntime();
      await tester.pumpWidget(_view(runtime, displayGeometry: source));
      await tester.pump();
      expect(_lastAccessibility(runtime)['reduceTransparency'], isTrue);

      source.emit(
        const PocketDisplayGeometrySnapshot(reduceTransparency: false),
      );
      await tester.pump();
      expect(_lastAccessibility(runtime)['reduceTransparency'], isFalse);
    },
  );

  testWidgets('defers geometry until the Flutter view size catches up', (
    tester,
  ) async {
    addTearDown(tester.view.reset);
    tester.view.devicePixelRatio = 1;
    tester.view.physicalSize = const Size(400, 520);
    final source = _FakeGeometrySource(
      const PocketDisplayGeometrySnapshot(
        supported: true,
        viewport: Size(410, 520),
        regions: <PocketDisplayRegion>[],
      ),
    );
    final runtime = _GeometryRuntime();
    await tester.pumpWidget(_view(runtime, displayGeometry: source));
    await tester.pump();
    expect(_viewportMessageCount(runtime), 0);

    source.emit(
      const PocketDisplayGeometrySnapshot(
        supported: true,
        viewport: Size(400, 520),
        regions: <PocketDisplayRegion>[],
      ),
    );
    await tester.pump();
    expect(_viewportMessageCount(runtime), 1);
  });
}
