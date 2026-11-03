import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:pocket_flutter/pocket_flutter.dart'
    show debugPocketFrameDeltaAtOverride, pocketFrameDeltaAt;
import 'package:pocket_host/main.dart';
import 'package:pocket_sdk/pocket_sdk.dart';

import 'guest_interaction_test.dart' as guest;

void main() {
  final binding = IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  binding.framePolicy = LiveTestWidgetsFlutterBindingFramePolicy.fullyLive;

  testWidgets(
    'real JS platform controls and sensor stream survive navigation',
    (tester) async {
      final controller = PocketSystemHostController();
      final events = <Map<String, Object?>>[];
      final previous = debugPocketFrameDeltaAtOverride;
      debugPocketFrameDeltaAtOverride = (runtime, deltaMilliseconds) {
        final frame = pocketFrameDeltaAt(runtime, deltaMilliseconds);
        for (final event in frame?.events ?? const []) {
          if (event.method == 'host.request' ||
              event.method.startsWith('stream.')) {
            events.add({'name': event.method, ...event.params});
          }
        }
        return frame;
      };
      try {
        await tester.pumpWidget(PocketHostApp(systemController: controller));
        await guest.waitFor(tester, '00');
        final session = controller.instances
            .singleWhere((instance) => instance.isSystemUI)
            .session;
        expect(session.failure, isNull);
        final initialError = session.lastError;

        await guest.tapGuest(tester, 'Hardware');
        await guest.tapGuest(tester, 'Check initial link');
        await guest.waitForContaining(tester, 'capability_denied');
        expect(session.failure, isNull);
        expect(session.lastError, initialError);

        await guest.tapGuest(tester, 'selection');
        await guest.waitForContaining(tester, 'Performed');
        await guest.tapGuest(tester, 'Dark bar');
        await guest.waitForContaining(tester, 'System UI dark · Applied');
        await guest.tapGuest(tester, 'Reset');
        await guest.waitForContaining(tester, 'System UI reset · Reset');

        await guest.tapGuest(tester, 'Start sensors');
        await guest.reveal(tester, 'Bluetooth characteristic');
        // A simulator has no motion hardware. A structured native error is a
        // legitimate outcome; it cannot be counted as a real sensor sample.
        String? sensorOutcome;
        for (var attempt = 0; attempt < 100; attempt++) {
          await tester.pump(const Duration(milliseconds: 30));
          for (final text in guest.texts(tester)) {
            if (text == 'watching' ||
                text.contains('hardware_') ||
                text.contains('permission_denied') ||
                text.contains('capability_denied')) {
              sensorOutcome = text;
              break;
            }
          }
          if (sensorOutcome != null) break;
        }
        expect(
          sensorOutcome,
          isNotNull,
          reason:
              'a sensor stream must show samples or a structured rejection; '
              'painted=${guest.texts(tester)}; events=$events',
        );
        expect(
          events.where(
            (event) =>
                event['name'] == 'stream.open' &&
                event['topic'] == 'hardware.sensors.watch',
          ),
          hasLength(1),
        );
        await guest.tapGuest(tester, 'Home', scroll: false);
        await guest.waitFor(tester, '00');
        await guest.tapGuest(tester, '+1', scroll: false);
        await guest.waitFor(tester, '01');
        expect(session.failure, isNull);
        expect(session.lastError, initialError);
        expect(
          events.where(
            (event) => event['capability'] == 'platform.links.initial',
          ),
          hasLength(1),
        );
        expect(
          events.where((event) => event['topic'] == 'platform.links.events'),
          isEmpty,
          reason: 'the default Showcase must not subscribe to Deep Links',
        );
        binding.reportData ??= {};
        binding.reportData!['legacyCapabilities'] = {
          'events': events,
          'sensorOutcome': sensorOutcome,
        };
      } finally {
        debugPocketFrameDeltaAtOverride = previous;
        await tester.pumpWidget(const SizedBox.shrink());
        await tester.pump();
      }
    },
  );
}
