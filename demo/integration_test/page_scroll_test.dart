import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:pocket_flutter/pocket_flutter.dart';
import 'package:pocket_host/main.dart';

import 'guest_interaction_test.dart' as guest;

void main() {
  final binding = IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  binding.framePolicy = LiveTestWidgetsFlutterBindingFramePolicy.fullyLive;

  testWidgets('real guest pages scroll their content under fixed chrome', (
    tester,
  ) async {
    try {
      // Use the narrow mobile layout so a scroll is required even when the
      // real Duo window is wide enough for columns and a side navigation rail.
      await tester.pumpWidget(
        const Align(
          alignment: Alignment.topLeft,
          child: SizedBox(width: 390, height: 600, child: PocketHostApp()),
        ),
      );
      await guest.waitFor(tester, '00');
      await guest.waitFor(tester, 'Counter');

      final homeIntroBefore = _textPoint(
        tester,
        'One runtime, one source of truth',
      );
      final homeAnchorBefore = _textPoint(tester, 'Counter');
      final headerBefore = _textPoint(tester, 'Pocket Host Lab');
      final homeNavBefore = _textPoint(tester, 'Home');
      expect(homeIntroBefore, isNotNull);
      expect(homeAnchorBefore, isNotNull);
      expect(headerBefore, isNotNull);
      expect(homeNavBefore, isNotNull);

      await _dragUpAcrossViewport(tester);
      await tester.pump(const Duration(milliseconds: 120));
      // The native frame culls text outside the viewport. The bottom marker
      // is therefore expected to appear only after the real drag reaches it.
      await _waitForPaintedText(tester, 'Ready for input');

      final homeIntroAfter = _textPoint(
        tester,
        'One runtime, one source of truth',
      );
      final nativeBoundaryAfter = _textPoint(tester, 'Ready for input');
      final homeAnchorAfter = _textPoint(tester, 'Counter');
      final headerAfter = _textPoint(tester, 'Pocket Host Lab');
      final homeNavAfter = _textPoint(tester, 'Home');
      expect(nativeBoundaryAfter, isNotNull);
      expect(headerAfter, isNotNull);
      expect(homeNavAfter, isNotNull);
      _expectScrolledOrCulled(
        before: homeIntroBefore!,
        after: homeIntroAfter,
        label: 'Home intro',
      );
      _expectScrolledOrCulled(
        before: homeAnchorBefore!,
        after: homeAnchorAfter,
        label: 'Home counter anchor',
      );
      expect(
        headerAfter!.y,
        closeTo(headerBefore!.y, 2),
        reason: 'the JS header is outside the page scroller',
      );
      expect(
        homeNavAfter!.y,
        closeTo(homeNavBefore!.y, 2),
        reason: 'the JS navigation bar is outside the page scroller',
      );
      _expectBottomContentVisible(
        bottom: nativeBoundaryAfter!,
        navigation: homeNavAfter,
        frameHeight: _frameHeight(tester),
      );

      // The full-width Duo layout can fit the Gallery content without any
      // scroll range. Restart the real host in a bounded viewport so this
      // check tests measured layout/clip behavior instead of forcing a drag
      // on a page that legitimately fits.
      await tester.pumpWidget(const SizedBox.shrink());
      await tester.pump();
      await tester.pumpWidget(
        const Align(
          alignment: Alignment.topCenter,
          child: SizedBox(width: 390, height: 360, child: PocketHostApp()),
        ),
      );
      // The 360pt preview deliberately clips the lower Home controls. Its
      // fixed navigation, not the off-screen counter, is the ready marker.
      await guest.waitFor(tester, 'Home');
      await guest.tapGuest(tester, 'Gallery');
      await guest.waitFor(tester, 'Official building blocks');
      final galleryIntroBefore = _textPoint(tester, 'Official building blocks');
      final galleryHeaderBefore = _textPoint(tester, 'Pocket Host Lab');
      final galleryNavBefore = _textPoint(tester, 'Gallery');
      final galleryBottomBefore = _textPoint(tester, 'Not mounted here');
      expect(galleryIntroBefore, isNotNull);
      expect(galleryHeaderBefore, isNotNull);
      expect(galleryNavBefore, isNotNull);
      expect(
        galleryBottomBefore,
        isNull,
        reason: 'compact Gallery must begin with its bottom card clipped',
      );

      await _dragUpAcrossViewport(tester);
      await tester.pump(const Duration(milliseconds: 120));
      await _waitForPaintedText(tester, 'Not mounted here');
      final galleryIntroAfter = _textPoint(tester, 'Official building blocks');
      final galleryBottomAfter = _textPoint(tester, 'Not mounted here');
      final galleryHeaderAfter = _textPoint(tester, 'Pocket Host Lab');
      final galleryNavAfter = _textPoint(tester, 'Gallery');
      expect(galleryBottomAfter, isNotNull);
      expect(galleryHeaderAfter, isNotNull);
      expect(galleryNavAfter, isNotNull);
      _expectScrolledOrCulled(
        before: galleryIntroBefore!,
        after: galleryIntroAfter,
        label: 'Gallery intro',
      );
      expect(
        galleryHeaderAfter!.y,
        closeTo(galleryHeaderBefore!.y, 2),
        reason: 'the JS header is outside the page scroller',
      );
      expect(
        galleryNavAfter!.y,
        closeTo(galleryNavBefore!.y, 2),
        reason: 'the JS navigation bar is outside the page scroller',
      );
      _expectBottomContentVisible(
        bottom: galleryBottomAfter!,
        navigation: galleryNavAfter,
        frameHeight: _frameHeight(tester),
      );

      // Keep navigation itself in the JS guest; this final route check also
      // proves the fixed bottom navigation remains usable after scrolling.
      await guest.tapGuest(tester, 'Host');
      await guest.waitFor(tester, 'Runtime');
      expect(_textPoint(tester, 'Runtime'), isNotNull);
    } finally {
      await tester.pumpWidget(const SizedBox.shrink());
      await tester.pump();
    }
  });
}

Future<void> _dragUpAcrossViewport(WidgetTester tester) async {
  final view = find.byType(PocketView);
  expect(view, findsOneWidget);
  final box = tester.renderObject<RenderBox>(view);
  final size = box.size;
  final start = box.localToGlobal(Offset(size.width * .88, size.height * .74));
  final finish = box.localToGlobal(Offset(size.width * .88, size.height * .24));
  final gesture = await tester.startGesture(start);
  await tester.pump(const Duration(milliseconds: 16));
  const steps = 10;
  for (var index = 1; index <= steps; index++) {
    final fraction = index / steps;
    await gesture.moveTo(
      Offset(
        start.dx + (finish.dx - start.dx) * fraction,
        start.dy + (finish.dy - start.dy) * fraction,
      ),
    );
    await tester.pump(const Duration(milliseconds: 16));
  }
  await gesture.up();
  await tester.pump(const Duration(milliseconds: 16));
  // Let the real kinetic scroller settle at its measured content extent. A
  // fixed oversized extent would leave the bottom card far above the fixed
  // navigation bar, which this test deliberately rejects below.
  for (var index = 0; index < 30; index++) {
    await tester.pump(const Duration(milliseconds: 16));
  }
}

void _expectBottomContentVisible({
  required _TextPoint bottom,
  required _TextPoint navigation,
  required double frameHeight,
}) {
  expect(
    bottom.y,
    greaterThanOrEqualTo(-2),
    reason: 'bottom content should not be scrolled into a blank tail',
  );
  expect(
    bottom.y + bottom.height,
    lessThan(frameHeight),
    reason: 'bottom content should remain inside the guest frame',
  );
  expect(
    navigation.y - (bottom.y + bottom.height),
    lessThan(frameHeight * .45),
    reason: 'bottom content should finish near the fixed navigation bar',
  );
}

void _expectScrolledOrCulled({
  required _TextPoint before,
  required _TextPoint? after,
  required String label,
}) {
  // DrawList culls text outside the viewport. Disappearance is a valid
  // result of scrolling; if the anchor remains, it must have moved upward.
  if (after == null) return;
  expect(
    after.y,
    lessThan(before.y - 20),
    reason: '$label must move with the guest page scroller',
  );
}

Future<void> _waitForPaintedText(WidgetTester tester, String value) async {
  for (var index = 0; index < 160; index++) {
    if (_textPoint(tester, value) != null) return;
    await tester.pump(const Duration(milliseconds: 30));
  }
  fail(
    'Guest did not paint "$value" after a real scroll: ${guest.texts(tester)}',
  );
}

double _frameHeight(WidgetTester tester) {
  final painter = guest.painters(tester).first.painter! as PocketCanvasPainter;
  return painter.height;
}

_TextPoint? _textPoint(WidgetTester tester, String value) {
  for (final widget in guest.painters(tester)) {
    final painter = widget.painter! as PocketCanvasPainter;
    for (final operation in painter.ops.whereType<PocketTextOp>()) {
      if (operation.text == value) {
        return _TextPoint(
          x: operation.x,
          y: operation.y,
          width: operation.width,
          height: operation.height,
        );
      }
    }
  }
  return null;
}

final class _TextPoint {
  const _TextPoint({
    required this.x,
    required this.y,
    required this.width,
    required this.height,
  });

  final double x;
  final double y;
  final double width;
  final double height;
}
