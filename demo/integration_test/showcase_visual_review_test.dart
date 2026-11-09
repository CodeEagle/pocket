import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:pocket_host/main.dart';

import 'guest_interaction_test.dart' as guest;
import 'showcase_mobile_test.dart' as showcase;

bool _isStructuredSensorText(String value) {
  final lower = value.toLowerCase();
  return value == 'Live host result' ||
      value.startsWith('Motion ') ||
      value.startsWith('Pressure ') ||
      value.startsWith('Status · ') ||
      lower.contains('hardware_') ||
      lower.contains('permission denied') ||
      lower.contains('unsupported') ||
      lower.contains('unavailable') ||
      lower.contains('denied');
}

bool _hasVisibleSensorError(List<String> painted) {
  for (var index = 0; index < painted.length; index++) {
    if (painted[index] != 'Sensors') continue;
    final end = (index + 5 < painted.length) ? index + 5 : painted.length;
    final cardTexts = painted.sublist(index, end);
    if (cardTexts.contains('error') && cardTexts.contains('Sensor read')) {
      return true;
    }
  }
  return false;
}

Future<void> _waitForSensorTerminal(WidgetTester tester) async {
  for (var attempt = 0; attempt < 200; attempt++) {
    final painted = guest.texts(tester);
    if (painted.contains('Sensor read') &&
        (painted.any(_isStructuredSensorText) ||
            _hasVisibleSensorError(painted))) {
      return;
    }
    await tester.pump(const Duration(milliseconds: 50));
  }
  fail(
    'Sensor read did not paint a real structured host result; '
    'paintedTexts=${guest.texts(tester)}',
  );
}

void main() {
  final binding = IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  binding.framePolicy = LiveTestWidgetsFlutterBindingFramePolicy.fullyLive;

  testWidgets('portrait showcase visual review: Gallery, Host and Hardware', (
    tester,
  ) async {
    try {
      await tester.pumpWidget(
        Align(
          alignment: Alignment.topLeft,
          child: RepaintBoundary(
            key: showcase.captureKey,
            child: SizedBox(
              width: 390,
              height: 780,
              child: pocketHostApp(),
            ),
          ),
        ),
      );
      await guest.waitFor(tester, '00');
      expect(guest.texts(tester), contains('Pocket'));

      await guest.tapGuest(tester, 'UI', scroll: false);
      await guest.waitFor(tester, 'Official building blocks');
      expect(guest.texts(tester), contains('Text'));
      await guest.tapGuest(tester, 'Text');
      await guest.waitForContaining(
        tester,
        'Typography drawn by the active host.',
      );
      await guest.tapGuest(tester, 'Close', scroll: false);
      await guest.waitFor(tester, 'Official building blocks');
      await showcase.capture(tester, 'visual-gallery');

      await guest.tapGuest(tester, 'Host', scroll: false);
      await guest.waitFor(tester, 'Runtime');
      await guest.waitForContaining(
        tester,
        'Live host status and package identity.',
      );
      await showcase.capture(tester, 'visual-host');

      await guest.tapGuest(tester, 'Home', scroll: false);
      await guest.waitFor(tester, 'Pocket');

      await guest.tapGuest(tester, 'Hardware');
      await guest.waitFor(tester, 'Hardware');
      for (final label in ['Home', 'UI', 'Host', 'Settings']) {
        expect(
          guest.pointFor(tester, label),
          isNull,
          reason:
              'secondary Hardware page must hide the primary $label navigation item',
        );
      }
      await guest.reveal(tester, 'Read sensors');
      await guest.tapGuest(tester, 'Read sensors', scroll: false);
      await guest.reveal(tester, 'Sensor read');
      // The test accepts the simulator's structured unsupported/denied result
      // or a real numeric sensor result. It never injects a fake response.
      await _waitForSensorTerminal(tester);
      await showcase.capture(tester, 'visual-hardware');

      await showcase.tapBackIcon(tester);
      await guest.waitFor(tester, 'Pocket');
      await guest.tapGuest(tester, 'UI', scroll: false);
      await guest.waitFor(tester, 'Official building blocks');
    } finally {
      await tester.pumpWidget(const SizedBox.shrink());
      await tester.pump();
    }
  });
}
