import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:pocket_flutter/pocket_flutter.dart';
import 'package:pocket_host/main.dart';

import 'guest_interaction_test.dart' as guest;

double _logicalViewInsetBottom(WidgetTester tester) {
  final rawInset = tester.view.viewInsets.bottom;
  final devicePixelRatio = tester.view.devicePixelRatio;
  // FlutterView.viewInsets is reported in physical pixels, including during
  // the animated IME transition. Mirror PocketView's production conversion;
  // a value below logical height is still physical while the keyboard rises.
  if (!devicePixelRatio.isFinite || devicePixelRatio <= 0) return rawInset;
  return rawInset / devicePixelRatio;
}

double _keyboardAvailableBottom(WidgetTester tester, Rect surfaceBounds) {
  final devicePixelRatio = tester.view.devicePixelRatio;
  final logicalHeight = devicePixelRatio <= 0
      ? tester.view.physicalSize.height
      : tester.view.physicalSize.height / devicePixelRatio;
  final keyboardTop = logicalHeight - _logicalViewInsetBottom(tester);
  return math.min(surfaceBounds.bottom, keyboardTop);
}

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
    const fixedLayoutAnchors = <String>{'Home', 'Gallery', 'Host'};
    const inputLayoutAnchors = <String>{'Input round-trip', 'Tap to type'};
    var referenceAnchors = <String, Rect>{};
    final keyboardAnchorFrames = <Map<String, Rect>>[];
    final keyboardInputAnchorFrames = <Map<String, Rect>>[];
    var keyboardFramesObserved = 0;
    var lastMissingKeyboardAnchors = <String>{};
    var lastKeyboardTextOps = <String>[];
    var keyboardInputFramesObserved = 0;
    Rect? firstKeyboardInputBounds;
    Rect? firstKeyboardInputTextRect;
    var inputAlignmentSamples = 0;
    var maxInputTextMovement = 0.0;
    var inputObscuredByKeyboard = false;
    double? keyboardAvailableBottom;

    // Keep the real production frame seam under observation while this test
    // runs. The ring is intentionally bounded so a long-lived device test
    // cannot retain every frame it ever rendered.
    final previousFrameDeltaOverride = debugPocketFrameDeltaAtOverride;
    final frameDeltaTrace = <String>[];
    var frameDeltaSequence = 0;
    double? previousInset;

    void recordFrameDelta(String entry) {
      if (frameDeltaTrace.length >= 200) frameDeltaTrace.removeAt(0);
      frameDeltaTrace.add('#${frameDeltaSequence++} $entry');
    }

    String formatNumber(Object? value) {
      if (value is num && value.isFinite) return value.toStringAsFixed(2);
      return '-';
    }

    String formatTextInputUpdateRects(PocketFrame? frame) {
      if (frame == null) return '-';
      final rects = <String>[];
      for (final event in frame.events.where(
        (event) => event.method == 'textInput.update',
      )) {
        final rawRect = event.params['rect'];
        final rect = rawRect is Map ? rawRect : event.params;
        final x = rect['x'];
        final y = rect['y'];
        final width = rect['width'] ?? rect['w'];
        final height = rect['height'] ?? rect['h'];
        rects.add(
          '{x:${formatNumber(x)},y:${formatNumber(y)},'
          'w:${formatNumber(width)},h:${formatNumber(height)}}',
        );
      }
      return rects.isEmpty ? '-' : rects.join(';');
    }

    String formatInputTextY(PocketFrame? frame) {
      if (frame == null) return '-';
      final ys = frame.ops
          .whereType<PocketTextOp>()
          .where((op) => op.text == 'Tap to type')
          .map((op) => formatNumber(op.y))
          .toList(growable: false);
      return ys.isEmpty ? '-' : ys.join(',');
    }

    // Temporary diagnostic for the intermittent 148 -> 111 draw-list
    // transition. A non-null delta frame is a new native DrawList, so record
    // its viewport and the key page text geometry to distinguish JS scroll
    // state from native culling/clip state. Remove after the Duo root-cause
    // run; this is deliberately test-only and does not alter the bridge.
    String formatFramePaintDiagnostics(PocketFrame? frame) {
      if (frame == null) return '-';
      final counts = <String, int>{};
      final anchors = <String>[];
      const labels = <String>{
        'Home',
        'Gallery',
        'Host',
        'Input round-trip',
        'Tap to type',
        'Counter',
      };
      for (final op in frame.ops) {
        final type = op.runtimeType.toString();
        counts[type] = (counts[type] ?? 0) + 1;
        if (op case final PocketTextOp text when labels.contains(text.text)) {
          final clip = text.clip;
          anchors.add(
            '${text.text}@${formatNumber(text.x)},${formatNumber(text.y)}'
            ' ${formatNumber(text.width)}x${formatNumber(text.height)}'
            '${clip == null ? '' : ' clip=${formatNumber(clip.x)},${formatNumber(clip.y)},${formatNumber(clip.width)}x${formatNumber(clip.height)}'}',
          );
        }
      }
      final viewportEvents = frame.events
          .where((event) => event.method == 'display.viewport')
          .map((event) => event.params)
          .toList(growable: false);
      return 'frame=${formatNumber(frame.width)}x${formatNumber(frame.height)} '
          'counts=$counts anchors=${anchors.isEmpty ? '-' : anchors.join('|')} '
          'viewport=${viewportEvents.isEmpty ? '-' : viewportEvents.join('|')}';
    }

    debugPocketFrameDeltaAtOverride = (runtime, deltaMilliseconds) {
      final insetBefore = tester.view.viewInsets.bottom;
      final priorInset = previousInset;
      PocketFrame? frame;
      try {
        // Call the production seam directly. It does not consult this test
        // override, so this cannot recurse and preserves the real FFI path.
        frame = pocketFrameDeltaAt(runtime, deltaMilliseconds);
      } catch (error) {
        recordFrameDelta(
          'inset=${formatNumber(priorInset)}->${formatNumber(insetBefore)} '
          'resize=error delta=${formatNumber(deltaMilliseconds)} '
          'ops=error inputY=- updateRects=- error=$error',
        );
        rethrow;
      }
      final insetAfter = tester.view.viewInsets.bottom;
      final changedBefore =
          priorInset != null && (insetBefore - priorInset).abs() > .1;
      final changedDuring = (insetAfter - insetBefore).abs() > .1;
      final resize = changedBefore || changedDuring ? 'changed' : 'steady';
      recordFrameDelta(
        'inset=${formatNumber(insetBefore)}->${formatNumber(insetAfter)} '
        'resize=$resize delta=${formatNumber(deltaMilliseconds)} '
        'ops=${frame == null ? 'null' : frame.ops.length} '
        'inputY=${formatInputTextY(frame)} '
        'updateRects=${formatTextInputUpdateRects(frame)} '
        'paint=${formatFramePaintDiagnostics(frame)}',
      );
      previousInset = insetAfter;
      return frame;
    };

    void recordKeyboardAnchors(PocketCanvasPainter painter) {
      if (tester.view.viewInsets.bottom <= 0 || referenceAnchors.isEmpty) {
        return;
      }
      keyboardFramesObserved++;
      final anchors = _guestTextRects(layoutAnchors);
      final fixedAnchors = <String, Rect>{
        for (final label in fixedLayoutAnchors)
          if (anchors[label] case final rect?) label: rect,
      };
      final inputAnchors = <String, Rect>{
        for (final label in inputLayoutAnchors)
          if (anchors[label] case final rect?) label: rect,
      };
      // The input page is allowed to scroll vertically to keep the Flutter
      // editor visible. Navigation is not allowed to change responsive mode,
      // so use the fixed rail anchors as the per-frame layout sample and keep
      // any visible input anchors as an independent coverage sample.
      if (fixedAnchors.length == fixedLayoutAnchors.length) {
        keyboardAnchorFrames.add(fixedAnchors);
      }
      if (inputAnchors.isNotEmpty) keyboardInputAnchorFrames.add(inputAnchors);
      final missing = layoutAnchors.difference(anchors.keys.toSet());
      if (missing.isNotEmpty) {
        lastMissingKeyboardAnchors = missing;
        lastKeyboardTextOps = painter.ops
            .whereType<PocketTextOp>()
            .map((op) => op.text)
            .toList(growable: false);
      }
    }

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
        recordKeyboardAnchors(painter);
      });
    });
    try {
      await tester.pumpWidget(const PocketHostApp());
      await guest.waitForContaining(tester, 'Tap to type');
      referenceAnchors = await _waitForStableGuestLayout(tester, layoutAnchors);
      const scrollSyncAnchors = <String>{
        'Input round-trip',
        'Tap to type',
        'Draft: (empty)',
        'Counter',
      };
      const adjacentPageAnchors = <String>['Counter', 'Draft: (empty)'];
      final referenceSurfaceBounds = tester.getRect(find.byType(PocketView));
      final referenceScrollRects = _guestTextGlobalRects(
        tester,
        scrollSyncAnchors,
      );
      final referenceInputTextRect = referenceScrollRects['Tap to type'];
      if (referenceInputTextRect == null) {
        fail('The reference guest input rect was not painted');
      }
      var synchronizedPageSamples = 0;
      var movedPageSamples = 0;
      Rect? firstKeyboardSurfaceBounds;
      var firstKeyboardInset = 0.0;
      Map<String, Rect> lastKeyboardScrollRects = const <String, Rect>{};
      Rect? firstKeyboardHintRect;
      Rect? lastKeyboardHintRect;
      var keyboardHintSamples = 0;
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
      final keyboardSurfaceBounds = tester.getRect(find.byType(PocketView));
      final availableBottom = _keyboardAvailableBottom(
        tester,
        keyboardSurfaceBounds,
      );
      keyboardAvailableBottom = availableBottom;
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
        final inputBounds = tester.getRect(find.byType(TextField));
        final surfaceBounds = tester.getRect(find.byType(PocketView));
        final frameAvailableBottom = _keyboardAvailableBottom(
          tester,
          surfaceBounds,
        );
        keyboardAvailableBottom = math.min(
          keyboardAvailableBottom ?? frameAvailableBottom,
          frameAvailableBottom,
        );
        inputObscuredByKeyboard =
            referenceInputTextRect.bottom > keyboardAvailableBottom + 1;
        firstKeyboardInputBounds ??= inputBounds;
        firstKeyboardSurfaceBounds ??= surfaceBounds;
        firstKeyboardInset = tester.view.viewInsets.bottom;
        final hintFinder = find.text('Tap to type');
        if (hintFinder.evaluate().isNotEmpty) {
          final hintRect = tester.getRect(hintFinder.first);
          firstKeyboardHintRect ??= hintRect;
          lastKeyboardHintRect = hintRect;
          keyboardHintSamples++;
        }
        keyboardInputFramesObserved++;
        expect(inputBounds.top, greaterThanOrEqualTo(surfaceBounds.top));
        expect(inputBounds.bottom, lessThanOrEqualTo(surfaceBounds.bottom));
        expect(
          inputBounds.left,
          closeTo(firstKeyboardInputBounds.left, 2),
          reason: 'Flutter input must keep its horizontal anchor during IME',
        );
        expect(
          inputBounds.width,
          closeTo(firstKeyboardInputBounds.width, 2),
          reason: 'Flutter input must keep its width during IME',
        );
        final currentScrollRects = _guestTextGlobalRects(
          tester,
          scrollSyncAnchors,
        );
        lastKeyboardScrollRects = currentScrollRects;
        final currentInputTextRect = currentScrollRects['Tap to type'];
        if (currentInputTextRect != null) {
          inputAlignmentSamples++;
          firstKeyboardInputTextRect ??= currentInputTextRect;
          // The Flutter hint is the only native overlay for this JS-owned
          // field. Compare its global glyph origin with the guest text op so
          // a merely co-moving but detached TextField cannot pass.
          expect(
            hintFinder,
            findsOneWidget,
            reason: 'Flutter hint must be attached to the JS input text',
          );
          final hintRect = tester.getRect(hintFinder.first);
          expect(
            hintRect.left,
            closeTo(currentInputTextRect.left, 2),
            reason: 'Flutter hint must share the JS input text left edge',
          );
          expect(
            hintRect.top,
            closeTo(currentInputTextRect.top, 2),
            reason: 'Flutter hint must share the JS input text top edge',
          );
          final inputTextDeltaX =
              currentInputTextRect.left - referenceInputTextRect.left;
          final inputTextDeltaY =
              currentInputTextRect.top - referenceInputTextRect.top;
          maxInputTextMovement = math.max(
            maxInputTextMovement,
            inputTextDeltaY.abs(),
          );
          final textStepX =
              currentInputTextRect.left - firstKeyboardInputTextRect.left;
          final textStepY =
              currentInputTextRect.top - firstKeyboardInputTextRect.top;
          final flutterStepX = inputBounds.left - firstKeyboardInputBounds.left;
          final flutterStepY = inputBounds.top - firstKeyboardInputBounds.top;
          expect(
            flutterStepX,
            closeTo(textStepX, 2),
            reason: 'Flutter input must move with the JS input text',
          );
          expect(
            flutterStepY,
            closeTo(textStepY, 2),
            reason: 'Flutter input must scroll with the JS input text',
          );
          final inputTitle = currentScrollRects['Input round-trip'];
          final referenceInputTitle = referenceScrollRects['Input round-trip'];
          if (inputTitle != null && referenceInputTitle != null) {
            expect(
              inputTitle.left - referenceInputTitle.left,
              closeTo(inputTextDeltaX, 2),
              reason: 'Input card title must move with its editor',
            );
            expect(
              inputTitle.top - referenceInputTitle.top,
              closeTo(inputTextDeltaY, 2),
              reason: 'Input card title must scroll with its editor',
            );
          }
          // A keyboard can cull the lower Counter card as the viewport
          // shrinks. Require an independently painted JS anchor that is
          // visible in this frame, preferring Counter and falling back to
          // the input card's Draft line. Either anchor must share the exact
          // scroll delta with the input text; missing anchors do not count.
          var hasAdjacentPageAnchor = false;
          for (final label in adjacentPageAnchors) {
            final current = currentScrollRects[label];
            final reference = referenceScrollRects[label];
            if (current == null || reference == null) continue;
            expect(
              current.left - reference.left,
              closeTo(inputTextDeltaX, 2),
              reason:
                  'Adjacent page content must keep the same horizontal offset',
            );
            expect(
              current.top - reference.top,
              closeTo(inputTextDeltaY, 2),
              reason: 'Adjacent page content must scroll with its editor',
            );
            hasAdjacentPageAnchor = true;
            break;
          }
          if (hasAdjacentPageAnchor) {
            synchronizedPageSamples++;
          }
          if (inputTextDeltaY.abs() > 2) movedPageSamples++;
        }
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
            final hostBox =
                find
                        .byType(PocketView)
                        .evaluate()
                        .firstOrNull
                        ?.findRenderObject()
                    as RenderBox?;
            if (canvasBox != null && hostBox != null) {
              final canvas = Rect.fromPoints(
                canvasBox.localToGlobal(Offset.zero),
                canvasBox.localToGlobal(
                  canvasBox.size.bottomRight(Offset.zero),
                ),
              );
              final hostOrigin = hostBox.localToGlobal(Offset.zero);
              transitionFrames.add((
                scaleX: canvas.width / painter.width,
                scaleY: canvas.height / painter.height,
                dx: canvas.left - hostOrigin.dx,
                dy: canvas.top - hostOrigin.dy,
              ));
            }
            recordKeyboardAnchors(painter);
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
        reason:
            'Capture JS layout during the real keyboard resize; '
            'observed=$keyboardFramesObserved, '
            'missing=$lastMissingKeyboardAnchors, '
            'textOps=$lastKeyboardTextOps',
      );
      expect(
        keyboardInputFramesObserved,
        greaterThan(5),
        reason: 'Keep the real Flutter input mounted throughout IME resize',
      );
      expect(
        inputAlignmentSamples,
        greaterThan(5),
        reason:
            'Keep the real Flutter input attached to the JS shell; '
            'samples=$inputAlignmentSamples '
            'referenceSurface=$referenceSurfaceBounds '
            'keyboardSurface=$firstKeyboardSurfaceBounds '
            'keyboardInset=$firstKeyboardInset '
            'firstInput=$firstKeyboardInputBounds '
            'referenceText=$referenceScrollRects '
            'lastText=$lastKeyboardScrollRects '
            'diagnostics=${_guestInputDiagnostics(tester)}',
      );
      debugPrint(
        'keyboard geometry: referenceText=$referenceScrollRects '
        'referenceSurface=$referenceSurfaceBounds '
        'keyboardSurface=$firstKeyboardSurfaceBounds '
        'keyboardInset=$firstKeyboardInset '
        'firstInput=$firstKeyboardInputBounds '
        'firstHint=$firstKeyboardHintRect '
        'lastHint=$lastKeyboardHintRect '
        'hintSamples=$keyboardHintSamples '
        'lastText=$lastKeyboardScrollRects',
      );
      expect(
        synchronizedPageSamples,
        greaterThan(5),
        reason:
            'Input card and adjacent page content must be sampled with the '
            'same scroll delta; samples=$synchronizedPageSamples',
      );
      if (inputObscuredByKeyboard) {
        expect(
          maxInputTextMovement,
          greaterThan(5),
          reason:
              'An obscured input must move above the keyboard by more than '
              '5px; movement=$maxInputTextMovement, '
              'input=$referenceInputTextRect, '
              'keyboardAvailableBottom=$keyboardAvailableBottom',
        );
        expect(
          movedPageSamples,
          greaterThan(5),
          reason:
              'The JS page must scroll above an obscured input; '
              'movedSamples=$movedPageSamples',
        );
      } else {
        debugPrint(
          'Keyboard left the raw input visible; no page movement required: '
          'input=$referenceInputTextRect '
          'keyboardAvailableBottom=$keyboardAvailableBottom',
        );
      }
      for (final anchors in keyboardAnchorFrames) {
        for (final label in fixedLayoutAnchors) {
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
      for (final anchors in keyboardInputAnchorFrames) {
        for (final label in inputLayoutAnchors) {
          final before = referenceAnchors[label];
          final during = anchors[label];
          if (before == null || during == null) continue;
          expect(
            during.left,
            closeTo(before.left, 2),
            reason: 'Keyboard resize must keep $label in the same pane',
          );
          expect(
            during.width,
            closeTo(before.width, 2),
            reason: 'Keyboard resize must keep $label width stable',
          );
        }
      }
      final routeTapTrace = <String>[];

      String routeTapSnapshot(String label) {
        final point = guest.pointFor(tester, 'Gallery');
        final pocketElements = find.byType(PocketView).evaluate();
        final surface = pocketElements.isEmpty
            ? null
            : pocketElements.single.findRenderObject() as RenderBox?;
        final local = point != null && surface != null
            ? surface.globalToLocal(point)
            : null;
        final galleryOps = <String>[];
        for (final painterWidget in guest.painters(tester)) {
          final painter = painterWidget.painter! as PocketCanvasPainter;
          for (final op in painter.ops.whereType<PocketTextOp>()) {
            if (op.text == 'Gallery') {
              galleryOps.add(
                '${op.x},${op.y},${op.width},${op.height}'
                '@${painter.width}x${painter.height}',
              );
            }
          }
        }
        Rect? inputRect;
        if (find.byType(TextField).evaluate().isNotEmpty) {
          inputRect = tester.getRect(find.byType(TextField));
        }
        return '$label: point=$point local=$local '
            'surface=${surface?.size} insets=${tester.view.viewInsets.bottom} '
            'editable=${find.byType(EditableText).evaluate().length} '
            'galleryOps=$galleryOps input=$inputRect';
      }

      routeTapTrace.add(routeTapSnapshot('before-first-gallery-tap'));
      await guest.tapGuest(tester, 'Gallery', scroll: false);
      routeTapTrace.add(routeTapSnapshot('after-first-gallery-tap'));
      try {
        await guest.waitFor(tester, 'Official building blocks');
      } catch (error) {
        fail('$error\n${routeTapTrace.join('\n')}');
      }
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
    } catch (error, stack) {
      debugPrint('keyboard lifecycle assertion/error: $error');
      debugPrint('$stack');
      debugPrint(
        'keyboard frame delta diagnostic (${frameDeltaTrace.length} entries):',
      );
      for (final entry in frameDeltaTrace) {
        debugPrint(entry);
      }
      rethrow;
    } finally {
      recordFrames = false;
      debugPocketFrameDeltaAtOverride = previousFrameDeltaOverride;
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

Map<String, Rect> _guestTextGlobalRects(
  WidgetTester tester,
  Iterable<String> labels,
) {
  final wanted = labels.toSet();
  final result = <String, Rect>{};
  for (final widget in guest.painters(tester)) {
    final painter = widget.painter! as PocketCanvasPainter;
    final element = find.byWidget(widget).evaluate().firstOrNull;
    final box = element?.renderObject;
    if (box is! RenderBox || !box.hasSize) continue;
    final scaleX = box.size.width / painter.width;
    final scaleY = box.size.height / painter.height;
    for (final textOp in painter.ops.whereType<PocketTextOp>()) {
      if (!wanted.contains(textOp.text) || result.containsKey(textOp.text)) {
        continue;
      }
      final logical = Rect.fromLTWH(
        textOp.x,
        textOp.y,
        textOp.width,
        textOp.height,
      );
      final topLeft = box.localToGlobal(
        Offset(logical.left * scaleX, logical.top * scaleY),
      );
      final bottomRight = box.localToGlobal(
        Offset(logical.right * scaleX, logical.bottom * scaleY),
      );
      result[textOp.text] = Rect.fromPoints(topLeft, bottomRight);
    }
  }
  return result;
}

String _guestInputDiagnostics(WidgetTester tester) {
  final blocks = <String>[];
  var index = 0;
  for (final widget in guest.painters(tester)) {
    final painter = widget.painter! as PocketCanvasPainter;
    final texts = painter.ops
        .whereType<PocketTextOp>()
        .map((op) => op.text)
        .toList(growable: false);
    final shapes = <String>[];
    for (final op in painter.ops) {
      if (op is PocketRoundedOp || op is PocketRectOp) {
        final containsInputText =
            op.x <= 220 &&
            op.y <= 420 &&
            op.x + op.width >= 80 &&
            op.y + op.height >= 300;
        if (containsInputText) {
          shapes.add(
            '${op.runtimeType}(${op.x},${op.y},${op.width},${op.height})',
          );
        }
      }
    }
    blocks.add(
      'block#$index ops=${painter.ops.length} texts=$texts shapes=$shapes',
    );
    index++;
  }
  return blocks.join(' | ');
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
      final unchanged =
          previous != null &&
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
