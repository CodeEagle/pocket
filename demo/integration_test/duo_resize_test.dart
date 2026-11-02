import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:pocket_flutter/pocket_flutter.dart';
import 'package:pocket_host/main.dart';

import 'guest_interaction_test.dart' as guest;
import 'showcase_mobile_test.dart' as showcase;

void main() {
  final binding = IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  binding.framePolicy = LiveTestWidgetsFlutterBindingFramePolicy.fullyLive;
  testWidgets(
    'live window changes preserve the real JS app and pointer mapping',
    (tester) async {
      final window = tester.view.physicalSize / tester.view.devicePixelRatio;
      final narrow = Size(
        math.min(390, window.width),
        math.min(600, window.height),
      );
      var available = narrow;
      late StateSetter setAvailable;
      try {
        await tester.pumpWidget(
          StatefulBuilder(
            builder: (context, setState) {
              setAvailable = setState;
              return Align(
                alignment: Alignment.topLeft,
                child: RepaintBoundary(
                  key: showcase.captureKey,
                  child: SizedBox(
                    width: available.width,
                    height: available.height,
                    child: const PocketHostApp(),
                  ),
                ),
              );
            },
          ),
        );
        await guest.waitFor(tester, '00');
        final initialController = tester
            .widget<PocketView>(find.byType(PocketView))
            .controller;
        await showcase.tap(tester, '+1');
        await guest.waitFor(tester, '01');
        await showcase.capture(tester, 'duo-narrow');

        for (final size in [
          window,
          Size(window.width, math.min(420, window.height)),
          narrow,
        ]) {
          setAvailable(() => available = size);
          await tester.pump(const Duration(milliseconds: 700));
          await guest.reveal(tester, '01');
          await guest.waitFor(tester, '01');
          final view = tester.widget<PocketView>(find.byType(PocketView));
          expect(
            identical(view.controller, initialController),
            isTrue,
            reason: 'A fold or split-window resize must not reload the guest',
          );
          final box = tester.renderObject<RenderBox>(find.byType(PocketView));
          final frame =
              guest.painters(tester).first.painter! as PocketCanvasPainter;
          expect(frame.width, closeTo(box.size.width, .01));
          expect(frame.height, closeTo(box.size.height, .01));
          expect(
            box.size.width,
            closeTo(size.width, .01),
            reason:
                'The canvas fills available width; JS places controls around safe regions',
          );
          if (size == window) await showcase.capture(tester, 'duo-wide');
        }
        await showcase.tap(tester, '+1');
        await guest.waitFor(tester, '02');
        await showcase.tap(tester, 'Gallery', scroll: false);
        await guest.waitFor(tester, 'Official building blocks');
        setAvailable(() => available = window);
        await tester.pump(const Duration(milliseconds: 700));
        await guest.waitFor(tester, 'Official building blocks');
        await showcase.capture(tester, 'duo-wide-gallery');
        await showcase.tap(tester, 'Home', scroll: false);
        await guest.waitFor(tester, '02');
        expect(tester.takeException(), isNull);
      } catch (_) {
        await showcase.capture(tester, 'duo-resize-failure');
        rethrow;
      } finally {
        await tester.pumpWidget(const SizedBox.shrink());
        await tester.pump();
      }
    },
  );
}
