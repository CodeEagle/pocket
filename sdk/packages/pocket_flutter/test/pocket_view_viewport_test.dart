import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pocket_flutter/pocket_flutter.dart';

final class _ViewportRuntime implements PocketRuntime {
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

Map<String, dynamic> _lastViewport(_ViewportRuntime runtime) {
  final message = runtime.messages.lastWhere(
    (message) => message['name'] == 'display.viewport',
  );
  return Map<String, dynamic>.from(message['payload'] as Map);
}

List<Map<String, dynamic>> _viewportMessages(_ViewportRuntime runtime) {
  return runtime.messages
      .where((message) => message['name'] == 'display.viewport')
      .toList(growable: false);
}

void _configureDuoLikeView(WidgetTester tester) {
  addTearDown(tester.view.reset);
  tester.view.devicePixelRatio = 1;
  tester.view.physicalSize = const Size(320, 480);
  // The right inset represents Duo's status/camera region. Values are kept
  // device-independent here; the production code reads the current view and
  // does not branch on a model or hard-coded display size.
  tester.view.viewPadding = const FakeViewPadding(
    top: 10,
    right: 20,
    bottom: 30,
    left: 5,
  );
  // TestFlutterView keeps the legacy `padding` property independently
  // mutable. On a real FlutterView it is derived from viewPadding/insets;
  // mirror that derived value so SafeArea exercises the same layout path.
  tester.view.padding = const FakeViewPadding(
    top: 10,
    right: 20,
    bottom: 0,
    left: 5,
  );
  tester.view.viewInsets = const FakeViewPadding(bottom: 80);
}

Widget _surface(_ViewportRuntime runtime) {
  return PocketView(
    runtime: runtime,
    jsSource: '',
    pakBytes: Uint8List(0),
    showDebugFps: false,
  );
}

void main() {
  testWidgets(
    'reports view safe area and keyboard overlap in guest coordinates',
    (tester) async {
      _configureDuoLikeView(tester);
      final runtime = _ViewportRuntime();
      await tester.pumpWidget(
        MaterialApp(
          home: Align(
            alignment: Alignment.topLeft,
            child: SizedBox(width: 320, height: 480, child: _surface(runtime)),
          ),
        ),
      );
      await tester.pump();

      final payload = _lastViewport(runtime);
      expect(payload['width'], 320);
      expect(payload['height'], 480);
      expect(payload['safeArea'], <String, double>{
        'top': 10,
        'right': 20,
        'bottom': 30,
        'left': 5,
      });
      expect(payload['keyboardInset'], 80);
    },
  );

  testWidgets(
    'rechecks a moved compositor child after layout without repeating stable geometry',
    (tester) async {
      _configureDuoLikeView(tester);
      final runtime = _ViewportRuntime();

      Widget buildSurface({required double top, required int revision}) {
        return MaterialApp(
          home: Stack(
            children: <Widget>[
              Positioned(
                left: 0,
                top: top,
                width: 320,
                height: 480,
                child: PocketView(
                  runtime: runtime,
                  jsSource: '',
                  pakBytes: Uint8List(0),
                  showDebugFps: false,
                  geometryRevision: revision,
                ),
              ),
            ],
          ),
        );
      }

      // The child has its real size but starts below the 480px FlutterView,
      // matching the mini-app entry surface before it reaches the top.
      await tester.pumpWidget(buildSurface(top: 480, revision: 0));
      await tester.pump();
      final initial = _viewportMessages(runtime);
      expect(initial, isNotEmpty);
      expect((_lastViewport(runtime)['safeArea'] as Map)['top'], 0);

      // The parent transform changes only the child's global position. The
      // revision is the explicit host notification that causes a post-layout
      // measurement, so the child now sees the 10px top system inset.
      await tester.pumpWidget(buildSurface(top: 0, revision: 1));
      await tester.pump();
      await tester.pump();
      final moved = _viewportMessages(runtime);
      expect(moved.length, greaterThan(initial.length));
      expect(_lastViewport(runtime)['safeArea'], <String, double>{
        'top': 10,
        'right': 20,
        'bottom': 30,
        'left': 5,
      });

      // A root frame can be rebuilt without moving the slot. No polling or
      // duplicate display.viewport event is allowed for stable geometry.
      await tester.pumpWidget(buildSurface(top: 0, revision: 1));
      await tester.pump();
      expect(_viewportMessages(runtime), hasLength(moved.length));
    },
  );

  testWidgets('keeps the guest tick diagnostic inside the local safe area', (
    tester,
  ) async {
    _configureDuoLikeView(tester);
    final runtime = _ViewportRuntime();
    await tester.pumpWidget(
      MaterialApp(
        home: SizedBox(
          width: 320,
          height: 480,
          child: PocketView(
            runtime: runtime,
            jsSource: '',
            pakBytes: Uint8List(0),
            showDebugFps: true,
          ),
        ),
      ),
    );
    await tester.pump();

    final label = find.textContaining('Guest ticks/s');
    expect(label, findsOneWidget);
    final position = tester.widget<Positioned>(
      find.ancestor(of: label, matching: find.byType(Positioned)).first,
    );
    expect(position.top, 16);
    expect(position.right, 26);
  });

  testWidgets(
    'does not double-count safe area and maps taps through a padded host',
    (tester) async {
      _configureDuoLikeView(tester);
      tester.view.viewInsets = FakeViewPadding.zero;
      tester.view.padding = const FakeViewPadding(
        top: 10,
        right: 20,
        bottom: 30,
        left: 5,
      );
      final runtime = _ViewportRuntime();
      await tester.pumpWidget(
        MaterialApp(
          home: SafeArea(
            child: SizedBox(width: 320, height: 480, child: _surface(runtime)),
          ),
        ),
      );
      await tester.pump();

      final payload = _lastViewport(runtime);
      expect(payload['safeArea'], <String, double>{
        'top': 0,
        'right': 0,
        'bottom': 0,
        'left': 0,
      });
      expect(payload['keyboardInset'], 0);

      final surface = find.byKey(const ValueKey<String>('pocket-surface-0'));
      final box = tester.renderObject<RenderBox>(surface);
      final origin = box.localToGlobal(Offset.zero);
      final gesture = await tester.startGesture(
        origin + Offset(box.size.width / 2, box.size.height / 2),
      );
      await tester.pump(const Duration(milliseconds: 16));
      await gesture.up();
      await tester.pump();

      final pointer = runtime.messages.lastWhere(
        (message) => message['name'] == 'input.pointer',
      );
      final point = pointer['payload'] as Map;
      expect(point['phase'], 'up');
      expect(point['x'], closeTo(160, 0.01));
      expect(point['y'], closeTo(240, 0.01));
    },
  );

  testWidgets('maps only the remaining keyboard overlap for a padded host', (
    tester,
  ) async {
    _configureDuoLikeView(tester);
    final runtime = _ViewportRuntime();
    await tester.pumpWidget(
      MaterialApp(
        home: SafeArea(
          child: SizedBox(width: 320, height: 480, child: _surface(runtime)),
        ),
      ),
    );
    await tester.pump();

    final payload = _lastViewport(runtime);
    final box = tester.renderObject<RenderBox>(
      find.byKey(const ValueKey<String>('pocket-surface-0')),
    );
    final rect = box.localToGlobal(Offset.zero) & box.size;
    final keyboardTop =
        tester.view.physicalSize.height - tester.view.viewInsets.bottom;
    final expected =
        ((rect.bottom - keyboardTop).clamp(0.0, rect.height).toDouble()) /
        (box.size.height / 480);
    expect(payload['keyboardInset'], closeTo(expected, 0.01));
    expect(
      payload['keyboardInset'],
      lessThan(tester.view.viewInsets.bottom),
      reason: 'a nested SafeArea must not forward the full view inset twice',
    );
  });
}
