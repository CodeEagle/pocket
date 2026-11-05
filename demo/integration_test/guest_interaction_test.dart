import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:pocket_flutter/pocket_flutter.dart';
import 'package:pocket_host/main.dart';

const _revealDragAttempts = 12;
const _revealSettleBudget = Duration(seconds: 4);
const _revealSamplePeriod = Duration(milliseconds: 50);

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
  // The guest's measured line wrapping inserts newlines into one text op.
  // Match the same words independently of the device's wrapping width.
  final whitespace = RegExp(r'\s+');
  final expected = fragment.replaceAll(whitespace, ' ');
  for (var i = 0; i < 200; i++) {
    await tester.pump(const Duration(milliseconds: 50));
    if (texts(
      tester,
    ).any((text) => text.replaceAll(whitespace, ' ').contains(expected))) {
      return;
    }
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
final class _PointSnapshot {
  const _PointSnapshot({
    this.point,
    this.rawRect,
    this.clipRect,
    this.visibleRect,
    this.visibleHeightFraction,
  });

  final Offset? point;
  final Rect? rawRect;
  final Rect? clipRect;
  final Rect? visibleRect;
  final double? visibleHeightFraction;
}

_PointSnapshot _pointSnapshot(WidgetTester tester, String label) {
  _PointSnapshot? best;
  var bestVisibleArea = -1.0;
  for (final widget in painters(tester).toList().reversed) {
    final painter = widget.painter! as PocketCanvasPainter;
    final box = tester.renderObject<RenderBox>(find.byWidget(widget));
    for (final op in painter.ops.whereType<PocketTextOp>()) {
      if (op.text != label) continue;
      final rawRect = Rect.fromLTWH(op.x, op.y, op.width, op.height);
      final clipRect = op.clip == null
          ? null
          : Rect.fromLTWH(
              op.clip!.x,
              op.clip!.y,
              op.clip!.width,
              op.clip!.height,
            );
      var visibleRect = rawRect;
      if (clipRect != null) {
        visibleRect = visibleRect.intersect(clipRect);
      }
      visibleRect = visibleRect.intersect(
        Rect.fromLTWH(0, 0, painter.width, painter.height),
      );
      final visibleHeightFraction = op.height <= 0
          ? 0.0
          : visibleRect.height / op.height;
      final snapshot = _PointSnapshot(
        rawRect: rawRect,
        clipRect: clipRect,
        visibleRect: visibleRect,
        visibleHeightFraction: visibleHeightFraction,
      );
      final visibleArea = visibleRect.isEmpty
          ? 0.0
          : visibleRect.width * visibleRect.height;
      if (best == null || visibleArea > bestVisibleArea) {
        best = snapshot;
        bestVisibleArea = visibleArea;
      }
      if (visibleRect.isEmpty || visibleRect.height < op.height * .5) {
        continue;
      }
      return _PointSnapshot(
        point: box.localToGlobal(
          Offset(
            visibleRect.center.dx * box.size.width / painter.width,
            visibleRect.center.dy * box.size.height / painter.height,
          ),
        ),
        rawRect: rawRect,
        clipRect: clipRect,
        visibleRect: visibleRect,
        visibleHeightFraction: visibleHeightFraction,
      );
    }
  }
  return best ?? const _PointSnapshot();
}

Offset? pointFor(WidgetTester tester, String label) =>
    _pointSnapshot(tester, label).point;

String _formatOffset(Offset? point) => point == null
    ? 'none'
    : '(${point.dx.toStringAsFixed(1)},${point.dy.toStringAsFixed(1)})';

String _formatRect(Rect? rect) => rect == null
    ? 'none'
    : '(${rect.left.toStringAsFixed(1)},${rect.top.toStringAsFixed(1)},'
          '${rect.right.toStringAsFixed(1)},${rect.bottom.toStringAsFixed(1)})';

/// Reveal content through real drags, including after the window gets shorter.
Future<Offset> reveal(
  WidgetTester tester,
  String label, {
  bool scroll = true,
}) async {
  final trajectory = <String>[];
  final revealClock = Stopwatch()..start();
  void record(String phase, _PointSnapshot snapshot) {
    // Retain both the initial drag samples and the latest settling samples;
    // otherwise twelve drags would fill the diagnostic buffer before the
    // inertia/stability phase could explain a failure.
    if (trajectory.length >= 24) trajectory.removeAt(12);
    trajectory.add(
      '${revealClock.elapsedMilliseconds}ms/$phase '
      'point=${_formatOffset(snapshot.point)} '
      'raw=${_formatRect(snapshot.rawRect)} '
      'clip=${_formatRect(snapshot.clipRect)} '
      'visible=${_formatRect(snapshot.visibleRect)} '
      'height=${snapshot.visibleHeightFraction?.toStringAsFixed(2) ?? 'none'}',
    );
  }

  // Scrolling and settling are separate budgets. A fling can keep moving the
  // target for seconds after the final drag, so its 0.5px stability check must
  // not consume the finite number of attempts reserved for revealing content.
  // A real viewport resize can also cull a target that was visible at the
  // first sample; retries below spend only the remaining drag budget and never
  // reset or extend the settle clock.
  var dragAttempts = 0;
  Future<void> dragOnce() async {
    final box = tester.renderObject<RenderBox>(activePocketViewFinder());
    final gesture = await tester.startGesture(
      box.localToGlobal(Offset(box.size.width * .35, box.size.height * .72)),
    );
    for (var i = 0; i < 10; i++) {
      await gesture.moveBy(const Offset(0, -23));
      await tester.pump(const Duration(milliseconds: 16));
      // Stop as soon as the target is pointable. A fixed ten-step drag can
      // reveal a target and then carry it past the top while the finger is
      // still moving, especially after a live viewport resize.
      if (_pointSnapshot(tester, label).point != null) break;
    }
    // The gesture recognizer estimates release velocity over its last three
    // virtual frames. Keep the contact down for that window so the real drag
    // ends at rest instead of starting a fling that moves the target away
    // between the visibility and stability samples.
    for (var i = 0; i < 3; i++) {
      await tester.pump(const Duration(milliseconds: 16));
    }
    await gesture.up();
    await tester.pump(const Duration(milliseconds: 100));
  }

  Future<void> performDragAttempt(_PointSnapshot snapshot) async {
    final attempt = dragAttempts++;
    record('before-drag-$attempt', snapshot);
    await dragOnce();
    record('after-drag-$attempt', _pointSnapshot(tester, label));
  }

  while (dragAttempts < (scroll ? _revealDragAttempts : 0)) {
    final snapshot = _pointSnapshot(tester, label);
    if (snapshot.point != null) break;
    await performDragAttempt(snapshot);
  }

  Offset? previous;
  final settleClock = Stopwatch()..start();
  while (settleClock.elapsed < _revealSettleBudget) {
    final snapshot = _pointSnapshot(tester, label);
    record('settle', snapshot);
    final point = snapshot.point;
    if (point != null) {
      // Initial native geometry and route transitions can move a painted
      // button before the next frame. Never send down at its old location
      // and up after reflow; wait for two samples within the existing 0.5px
      // threshold.
      if (previous != null && (point - previous).distance < .5) return point;
      previous = point;
    } else {
      previous = null;
      // The first visible sample can become stale when a real resize or
      // safe-area reflow culls the target on the next frame. Recover with a
      // real drag instead of waiting on an impossible stable sample or using
      // the old coordinate. The settle deadline remains unchanged.
      if (scroll && dragAttempts < _revealDragAttempts) {
        await performDragAttempt(snapshot);
        continue;
      }
    }
    await tester.pump(_revealSamplePeriod);
  }
  final last = _pointSnapshot(tester, label);
  record('timeout', last);
  // A real device can spend the entire settle budget inside the final pump
  // (for example while preparing its first raster resources). The snapshot
  // after that pump is still the required second geometry sample: accept it
  // only when the visible target stayed within the same stability threshold.
  final finalPoint = last.point;
  if (previous != null &&
      finalPoint != null &&
      (finalPoint - previous).distance < .5) {
    return finalPoint;
  }
  final hadPoint = trajectory.any((sample) => sample.contains('point=('));
  final status = hadPoint ? 'visible but did not stabilize' : 'not pointable';
  fail(
    'No visible guest target: $label ($status; '
    'dragAttempts=$dragAttempts/${scroll ? _revealDragAttempts : 0}; '
    'settleBudgetMs=${_revealSettleBudget.inMilliseconds}); '
    'actual=${texts(tester)}; trajectory=${trajectory.join(' | ')}',
  );
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
