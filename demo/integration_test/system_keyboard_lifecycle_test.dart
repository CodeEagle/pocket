import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:pocket_flutter/pocket_flutter.dart';
import 'package:pocket_host/main.dart';

import 'guest_interaction_test.dart' as guest;

void main() {
  final binding = IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  binding.framePolicy = LiveTestWidgetsFlutterBindingFramePolicy.fullyLive;

  testWidgets('real system keyboard survives viewport resize', (tester) async {
    // Deliberately no TestTextInput registration: this must open the device's
    // actual software keyboard and exercise native view-inset notifications.
    var recordFrames = true;
    final transitionFrames =
        <({double scaleX, double scaleY, double dx, double dy})>[];
    // The Duo's keyboard changes the host height, but it must not change the
    // horizontal responsive mode. Keep a small set of JS-painted anchors so
    // a transient rail flip (the exact failure seen in the screen recording)
    // is caught during the IME animation instead of only after it settles.
    const layoutAnchors = <String>{
      'Home',
      'Gallery',
      'Host',
      'Input round-trip',
      'Tap to type',
    };
    var referenceAnchors = <String, Rect>{};
    final keyboardAnchorFrames = <Map<String, Rect>>[];
    binding.addPersistentFrameCallback((_) {
      if (!recordFrames) return;
      binding.addPostFrameCallback((_) {
        if (!recordFrames || find.byType(PocketView).evaluate().isEmpty) return;
        // Inspect Elements/RenderBoxes directly here. WidgetTester query
        // helpers are guarded and cannot run in a frame callback while an
        // awaited tester.pump is still active.
        final paints = find
            .byWidgetPredicate(
              (widget) =>
                  widget is CustomPaint &&
                  widget.painter is PocketCanvasPainter,
            )
            .evaluate();
        if (paints.isEmpty) return;
        final paint = paints.first.widget as CustomPaint;
        final painter = paint.painter! as PocketCanvasPainter;
        final canvasBox = paints.first.findRenderObject()! as RenderBox;
        final hostBox =
            find.byType(PocketView).evaluate().single.findRenderObject()!
                as RenderBox;
        final canvas = Rect.fromPoints(
          canvasBox.localToGlobal(Offset.zero),
          canvasBox.localToGlobal(canvasBox.size.bottomRight(Offset.zero)),
        );
        final hostOrigin = hostBox.localToGlobal(Offset.zero);
        transitionFrames.add((
          scaleX: canvas.width / painter.width,
          scaleY: canvas.height / painter.height,
          dx: canvas.left - hostOrigin.dx,
          dy: canvas.top - hostOrigin.dy,
        ));
        final anchors = _guestTextRects(layoutAnchors);
        if (tester.view.viewInsets.bottom > 0 &&
            referenceAnchors.isNotEmpty &&
            layoutAnchors.every(anchors.containsKey)) {
          keyboardAnchorFrames.add(anchors);
        }
      });
    });
    try {
      await tester.pumpWidget(const PocketHostApp());
      await guest.waitForContaining(tester, 'Tap to type');
      referenceAnchors = await _waitForStableGuestLayout(
        tester,
        layoutAnchors,
      );
      await guest.tapGuest(tester, 'Tap to type');
      var sawKeyboard = false;
      for (var i = 0; i < 100; i++) {
        await tester.pump(const Duration(milliseconds: 50));
        if (tester.view.viewInsets.bottom > 0) {
          sawKeyboard = true;
          break;
        }
      }
      expect(
        sawKeyboard,
        isTrue,
        reason:
            'Device software keyboard must appear; '
            'editors=${find.byType(EditableText).evaluate().length}, '
            'guest=${guest.texts(tester)}',
      );
      final editor = tester.state<EditableTextState>(find.byType(EditableText));
      for (var i = 0; i < 60; i++) {
        final previousAnchorCount = keyboardAnchorFrames.length;
        await tester.pump(const Duration(milliseconds: 50));
        expect(find.byType(EditableText), findsOneWidget);
        expect(
          tester.state<EditableTextState>(find.byType(EditableText)),
          same(editor),
        );
        expect(editor.widget.focusNode.hasFocus, isTrue);
        expect(tester.view.viewInsets.bottom, greaterThan(0));
        if (keyboardAnchorFrames.length == previousAnchorCount) {
          final paints = find
              .byWidgetPredicate(
                (widget) =>
                    widget is CustomPaint &&
                    widget.painter is PocketCanvasPainter,
              )
              .evaluate();
          if (paints.isNotEmpty) {
            final paint = paints.first.widget as CustomPaint;
            final painter = paint.painter! as PocketCanvasPainter;
            final canvasBox = paints.first.findRenderObject() as RenderBox?;
            final hostBox = find
                .byType(PocketView)
                .evaluate()
                .firstOrNull
                ?.findRenderObject() as RenderBox?;
            if (canvasBox != null && hostBox != null) {
              final canvas = Rect.fromPoints(
                canvasBox.localToGlobal(Offset.zero),
                canvasBox.localToGlobal(canvasBox.size.bottomRight(Offset.zero)),
              );
              final hostOrigin = hostBox.localToGlobal(Offset.zero);
              transitionFrames.add((
                scaleX: canvas.width / painter.width,
                scaleY: canvas.height / painter.height,
                dx: canvas.left - hostOrigin.dx,
                dy: canvas.top - hostOrigin.dy,
              ));
            }
          }
          final anchors = _guestTextRects(layoutAnchors);
          if (tester.view.viewInsets.bottom > 0 &&
              referenceAnchors.isNotEmpty &&
              layoutAnchors.every(anchors.containsKey)) {
            keyboardAnchorFrames.add(anchors);
          }
        }
      }
      final inputBounds = tester.getRect(find.byType(TextField));
      final surfaceBounds = tester.getRect(find.byType(PocketView));
      expect(inputBounds.top, greaterThanOrEqualTo(surfaceBounds.top));
      expect(inputBounds.bottom, lessThanOrEqualTo(surfaceBounds.bottom));
      expect(
        keyboardAnchorFrames.length,
        greaterThan(5),
        reason: 'Capture JS layout during the real keyboard resize',
      );
      for (final anchors in keyboardAnchorFrames) {
        for (final label in layoutAnchors) {
          final before = referenceAnchors[label];
          final during = anchors[label];
          if (before == null || during == null) continue;
          expect(
            during.left,
            closeTo(before.left, 2),
            reason:
                'Keyboard resize must not move $label horizontally; '
                'a rail flip changes the JS responsive mode',
          );
          expect(
            during.width,
            closeTo(before.width, 2),
            reason: 'Keyboard resize must keep $label in the same pane',
          );
        }
      }
      await guest.tapGuest(tester, 'Gallery');
      await guest.waitFor(tester, 'Official building blocks');
      for (var i = 0; i < 100 && tester.view.viewInsets.bottom > 0; i++) {
        await tester.pump(const Duration(milliseconds: 50));
      }
      expect(find.byType(EditableText), findsNothing);
      expect(tester.view.viewInsets.bottom, 0);
      expect(transitionFrames.length, greaterThan(20));
      for (final frame in transitionFrames) {
        expect(
          frame.scaleX,
          closeTo(1, .001),
          reason: 'No horizontal page zoom during IME animation',
        );
        expect(
          frame.scaleY,
          closeTo(1, .001),
          reason: 'No vertical page zoom during IME animation',
        );
        expect(
          frame.dx,
          closeTo(0, .1),
          reason: 'Canvas keeps its left anchor',
        );
        expect(
          frame.dy,
          closeTo(0, .1),
          reason: 'Canvas keeps its top anchor; guest content scrolls',
        );
      }
    } finally {
      recordFrames = false;
      await tester.pumpWidget(const SizedBox.shrink());
      await tester.pump();
    }
  });
}

/// Read JS text draw records from the guest painter. These coordinates are in
/// the logical guest canvas, so they stay comparable while Flutter's host
/// render box is being clipped by the software keyboard.
Map<String, Rect> _guestTextRects(Iterable<String> labels) {
  final wanted = labels.toSet();
  final result = <String, Rect>{};
  // Use Element inspection instead of WidgetTester.widgetList: this helper
  // is also called from a post-frame callback, where guarded tester methods
  // cannot run while pump() is awaiting the frame.
  final paints = find
      .byWidgetPredicate(
        (widget) =>
            widget is CustomPaint && widget.painter is PocketCanvasPainter,
      )
      .evaluate();
  for (final element in paints) {
    final widget = element.widget;
    if (widget is! CustomPaint || widget.painter is! PocketCanvasPainter) {
      continue;
    }
    final painter = widget.painter! as PocketCanvasPainter;
    for (final op in painter.ops.whereType<PocketTextOp>()) {
      if (!wanted.contains(op.text) || result.containsKey(op.text)) continue;
      final rect = Rect.fromLTWH(op.x, op.y, op.width, op.height);
      if (rect.isEmpty) continue;
      result[op.text] = rect;
    }
  }
  return result;
}

Future<Map<String, Rect>> _waitForStableGuestLayout(
  WidgetTester tester,
  Iterable<String> labels,
) async {
  Map<String, Rect>? previous;
  var stable = 0;
  for (var index = 0; index < 80; index++) {
    await tester.pump(const Duration(milliseconds: 50));
    final current = _guestTextRects(labels);
    if (labels.every(current.containsKey)) {
      final unchanged = previous != null &&
          labels.every((label) {
            final before = previous![label]!;
            final after = current[label]!;
            return (before.left - after.left).abs() < .5 &&
                (before.top - after.top).abs() < .5 &&
                (before.width - after.width).abs() < .5 &&
                (before.height - after.height).abs() < .5;
          });
      stable = unchanged ? stable + 1 : 0;
      previous = current;
      if (stable >= 3) return current;
    }
  }
  fail('JS layout did not settle before opening keyboard: $previous');
}
