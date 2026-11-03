import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:pocket_sdk/pocket_sdk.dart';
import 'package:pocket_host/main.dart';

import 'guest_interaction_test.dart' as guest;

Future<PocketSystemInstanceSnapshot> _systemUi(
  WidgetTester tester,
  PocketSystemHostController host,
) async {
  for (var attempt = 0; attempt < 100; attempt++) {
    final matches = host.instances.where((entry) => entry.isSystemUI);
    if (matches.length == 1 && matches.single.firstFrameReady) {
      return matches.single;
    }
    await tester.pump(const Duration(milliseconds: 30));
  }
  fail(
    'SystemUI was not ready; instances=${host.instances.map((entry) => '${entry.appId}:${entry.ready}:${entry.firstFrameReady}:${entry.session.failure}').toList()}; '
    'paintedTexts=${guest.texts(tester)}',
  );
}

Map<String, Object?> _snapshot(
  String stage,
  PocketSession session,
  List<String> paintedTexts,
) => <String, Object?>{
  'stage': stage,
  'paintedTexts': List<String>.from(paintedTexts),
  'sessionFailure': session.failure?.toString(),
  'lastError': session.lastError,
};

void _expectHealthy(
  String stage,
  PocketSession session,
  String? initialLastError,
  List<String> paintedTexts,
) {
  expect(
    session.failure,
    isNull,
    reason:
        '$stage created a Guest session failure: ${session.failure}; '
        'paintedTexts=$paintedTexts',
  );
  expect(
    session.lastError,
    initialLastError,
    reason:
        '$stage changed PocketSession.lastError from $initialLastError '
        'to ${session.lastError}; paintedTexts=$paintedTexts',
  );
}

void main() {
  final binding = IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  binding.framePolicy = LiveTestWidgetsFlutterBindingFramePolicy.fullyLive;

  testWidgets(
    'real pointer Push Mobile route survives repeated transition back navigation',
    (tester) async {
      final host = PocketSystemHostController();
      final report = <String, Object?>{
        'flow':
            'Home -> Transitions -> Push Mobile -> Mobile UI -> Back x3 -> Home',
        'cycles': <Map<String, Object?>>[],
      };
      PocketSystemInstanceSnapshot? systemUi;
      String? initialLastError;
      try {
        await tester.pumpWidget(PocketHostApp(systemController: host));
        await guest.waitFor(tester, '00');
        systemUi = await _systemUi(tester, host);
        final session = systemUi.session;
        initialLastError = session.lastError;
        report['initial'] = _snapshot(
          'home-ready',
          session,
          guest.texts(tester),
        );
        _expectHealthy(
          'home-ready',
          session,
          initialLastError,
          guest.texts(tester),
        );

        // guest.tapGuest resolves painted bounds and sends a real down/up
        // pointer sequence to the native PocketView; no demo.navigate event
        // is used for this regression.
        await guest.tapGuest(tester, 'Transitions');
        await guest.waitFor(tester, 'Push Mobile');
        report['afterTransitions'] = _snapshot(
          'transitions-ready',
          session,
          guest.texts(tester),
        );
        _expectHealthy(
          'transitions-ready',
          session,
          initialLastError,
          guest.texts(tester),
        );

        for (var cycle = 1; cycle <= 3; cycle++) {
          final cycleReport = <String, Object?>{'cycle': cycle};
          final paintedBeforePush = guest.texts(tester);
          cycleReport['beforePush'] = _snapshot(
            'cycle-$cycle-before-push',
            session,
            paintedBeforePush,
          );

          await guest.tapGuest(tester, 'Push Mobile');
          await guest.waitFor(tester, 'Mobile UI');
          final paintedMobile = guest.texts(tester);
          cycleReport['afterPushMobile'] = _snapshot(
            'cycle-$cycle-after-push-mobile',
            session,
            paintedMobile,
          );
          _expectHealthy(
            'cycle-$cycle-after-push-mobile',
            session,
            initialLastError,
            paintedMobile,
          );
          expect(
            paintedMobile,
            contains('Mobile UI'),
            reason:
                'Push Mobile must paint the Mobile UI route; '
                'paintedTexts=$paintedMobile',
          );

          // Mobile UI's app-bar Back is also a real guest pointer target. It
          // pops the route stack and must return to the Transitions page.
          await guest.tapGuest(tester, 'Back');
          // The route's scroll offset is retained across the pop. Reveal the
          // button before waiting for its draw op; waitFor only samples the
          // current painted frame and cannot defeat draw-op culling.
          await guest.reveal(tester, 'Push Mobile');
          await guest.waitFor(tester, 'Push Mobile');
          final paintedTransitions = guest.texts(tester);
          cycleReport['afterBack'] = _snapshot(
            'cycle-$cycle-after-back',
            session,
            paintedTransitions,
          );
          _expectHealthy(
            'cycle-$cycle-after-back',
            session,
            initialLastError,
            paintedTransitions,
          );
          expect(
            paintedTransitions,
            contains('Push Mobile'),
            reason:
                'Back must return to Transitions; '
                'paintedTexts=$paintedTransitions',
          );
          (report['cycles']! as List<Map<String, Object?>>).add(cycleReport);
        }

        await guest.tapGuest(tester, 'Back');
        await guest.waitFor(tester, '00');
        final paintedHome = guest.texts(tester);
        report['afterHome'] = _snapshot(
          'home-after-cycles',
          session,
          paintedHome,
        );
        _expectHealthy(
          'home-after-cycles',
          session,
          initialLastError,
          paintedHome,
        );
      } catch (error, stackTrace) {
        report['exception'] = error.toString();
        report['stackTrace'] = stackTrace.toString();
        report['exceptionPaintedTexts'] = guest.texts(tester);
        report['exceptionSessionFailure'] = systemUi?.session.failure
            ?.toString();
        report['exceptionLastError'] = systemUi?.session.lastError;
        rethrow;
      } finally {
        report['finalPaintedTexts'] = guest.texts(tester);
        report['sessionFailure'] = systemUi?.session.failure?.toString();
        report['lastError'] = systemUi?.session.lastError;
        report['initialLastError'] = initialLastError;
        binding.reportData ??= <String, dynamic>{};
        binding.reportData!['pushNavigationRegression'] = report;
        await tester.pumpWidget(const SizedBox.shrink());
        await tester.pump();
      }
    },
  );
}
