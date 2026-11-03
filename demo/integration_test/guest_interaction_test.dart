import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:pocket_flutter/pocket_flutter.dart';
import 'package:pocket_host/main.dart';

Iterable<CustomPaint> painters(WidgetTester tester) =>
    tester.widgetList<CustomPaint>(
      find.byWidgetPredicate(
        (widget) =>
            widget is CustomPaint && widget.painter is PocketCanvasPainter,
      ),
    );

List<String> texts(WidgetTester tester) => [
  for (final widget in painters(tester))
    for (final op in (widget.painter! as PocketCanvasPainter).ops)
      if (op is PocketTextOp) op.text,
];

Future<void> waitFor(WidgetTester tester, String text) async {
  for (var i = 0; i < 100; i++) {
    await tester.pump(const Duration(milliseconds: 30));
    if (texts(tester).contains(text)) return;
  }
  final errors = tester
      .widgetList<Text>(find.byType(Text))
      .map((widget) => widget.data)
      .toList();
  final selectable = tester
      .widgetList<SelectableText>(find.byType(SelectableText))
      .map((widget) => widget.data)
      .toList();
  fail(
    'Real guest did not paint "$text". Actual: ${texts(tester)}; Flutter: $errors $selectable',
  );
}

Future<void> waitForContaining(WidgetTester tester, String fragment) async {
  for (var i = 0; i < 200; i++) {
    await tester.pump(const Duration(milliseconds: 50));
    if (texts(tester).any((text) => text.contains(fragment))) return;
  }
  fail(
    'Real guest did not paint fragment "$fragment". Actual: ${texts(tester)}',
  );
}

Finder activePocketViewFinder() {
  final activeViews = find.byWidgetPredicate(
    (widget) => widget is PocketView && widget.inputEnabled,
  );
  if (activeViews.evaluate().isNotEmpty) return activeViews.last;
  return find.byType(PocketView).last;
}

/// Only target the visible part of a DrawOp. A text record can survive
/// clipping even when its original center is outside the scroller viewport.
Offset? pointFor(WidgetTester tester, String label) {
  for (final widget in painters(tester).toList().reversed) {
    final painter = widget.painter! as PocketCanvasPainter;
    final box = tester.renderObject<RenderBox>(find.byWidget(widget));
    for (final op in painter.ops.whereType<PocketTextOp>()) {
      if (op.text != label) continue;
      var rect = Rect.fromLTWH(op.x, op.y, op.width, op.height);
      final clip = op.clip;
      if (clip != null) {
        rect = rect.intersect(
          Rect.fromLTWH(clip.x, clip.y, clip.width, clip.height),
        );
      }
      rect = rect.intersect(Rect.fromLTWH(0, 0, painter.width, painter.height));
      if (rect.isEmpty || rect.height < op.height * .5) continue;
      return box.localToGlobal(
        Offset(
          rect.center.dx * box.size.width / painter.width,
          rect.center.dy * box.size.height / painter.height,
        ),
      );
    }
  }
  return null;
}

/// Reveal content through real drags, including after the window gets shorter.
Future<Offset> reveal(
  WidgetTester tester,
  String label, {
  bool scroll = true,
}) async {
  for (var attempt = 0; attempt < (scroll ? 12 : 6); attempt++) {
    final point = pointFor(tester, label);
    if (point != null) {
      // Initial native geometry and route transitions can move a painted
      // button before the next frame. Never send down at its old location
      // and up after reflow; wait for the same visible target to settle.
      await tester.pump(const Duration(milliseconds: 50));
      final settled = pointFor(tester, label);
      if (settled != null && (settled - point).distance < .5) return settled;
      continue;
    }
    if (!scroll) {
      await tester.pump(const Duration(milliseconds: 50));
      continue;
    }
    final box = tester.renderObject<RenderBox>(activePocketViewFinder());
    final gesture = await tester.startGesture(
      box.localToGlobal(Offset(box.size.width * .35, box.size.height * .72)),
    );
    for (var i = 0; i < 10; i++) {
      await gesture.moveBy(const Offset(0, -23));
      await tester.pump(const Duration(milliseconds: 16));
    }
    await gesture.up();
    await tester.pump(const Duration(milliseconds: 100));
  }
  fail('No visible guest target: $label; actual=${texts(tester)}');
}

Future<void> tapGuest(
  WidgetTester tester,
  String label, {
  bool scroll = true,
}) async {
  final point = await reveal(tester, label, scroll: scroll);
  final gesture = await tester.startGesture(point);
  await tester.pump(const Duration(milliseconds: 50));
  await gesture.up();
  await tester.pump(const Duration(milliseconds: 550));
}

void main() {
  final binding = IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  binding.framePolicy = LiveTestWidgetsFlutterBindingFramePolicy.fullyLive;
  testWidgets('real native guest responds through Flutter pointer bridge', (
    tester,
  ) async {
    await tester.pumpWidget(const PocketHostApp());
    await waitFor(tester, '00');
    await tapGuest(tester, '+1');
    await waitFor(tester, '01');
    await tapGuest(tester, 'Gallery');
    await waitFor(tester, 'Official building blocks');
    await tapGuest(tester, 'Home');
    await waitFor(tester, '01');
    await tapGuest(tester, 'Host');
    await waitFor(tester, 'Runtime');
    await waitForContaining(tester, 'quickjs-bytecode');
    await waitForContaining(tester, 'flutter.package_info_plus');
    await tapGuest(tester, 'Bytecode');
    await waitFor(tester, 'Bytecode');
    await waitForContaining(tester, 'quickjs-bytecode');
    await tapGuest(tester, 'Plugins');
    await waitFor(tester, 'Installed plugins');
    await waitForContaining(tester, 'flutter.package_info_plus');
    await tapGuest(tester, 'Updates');
    await waitFor(tester, 'Current status');
    await waitForContaining(tester, 'configured=false');
    await tapGuest(tester, 'Check');
    await waitForContaining(tester, 'updates_not_configured');
    await tapGuest(tester, 'Stress');
    await tapGuest(tester, 'Run 500 nodes');
    await waitForContaining(tester, '500 retained nodes');
    await tapGuest(tester, 'Home');
    await waitFor(tester, '01');
    // Disposing the real surface must not leave its ticker/runtime alive.
    await tester.pumpWidget(const SizedBox.shrink());
    await tester.pump();
  });
}
