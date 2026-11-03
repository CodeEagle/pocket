import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:pocket_host/main.dart';
import 'package:pocket_sdk/pocket_sdk.dart';

import 'guest_interaction_test.dart' as guest;

const _sensorCapability = 'hardware.sensors.read';
const _sensorPollPeriod = Duration(milliseconds: 50);
const _sensorPollLimit = 200;

final _structuredSensorResult = RegExp(
  r'"ok"\s*:\s*(?:true|false)|'
  r'"(?:errorCode|code|status)"\s*:',
  caseSensitive: false,
);

final class _SensorReadObservation {
  const _SensorReadObservation({
    required this.attempt,
    required this.terminal,
    required this.sawLoading,
    required this.returnedToReadButton,
    required this.resultNonIdle,
    required this.structuredResult,
    required this.sensorLines,
    required this.paintedTexts,
    required this.initialLastError,
    required this.sessionFailure,
    required this.lastError,
  });

  final String attempt;
  final bool terminal;
  final bool sawLoading;
  final bool returnedToReadButton;
  final bool resultNonIdle;
  final bool structuredResult;
  final List<String> sensorLines;
  final List<String> paintedTexts;
  final String? initialLastError;
  final String? sessionFailure;
  final String? lastError;

  Map<String, Object?> toReport() => <String, Object?>{
    'attempt': attempt,
    'terminal': terminal,
    'sawLoading': sawLoading,
    'returnedToReadButton': returnedToReadButton,
    'resultNonIdle': resultNonIdle,
    'structuredResult': structuredResult,
    // These are the actual JS-painted capability lines, without unrelated
    // app text or native identifiers.
    'sensorLines': sensorLines,
    'paintedTexts': paintedTexts,
    'initialLastError': initialLastError,
    'sessionFailure': sessionFailure,
    'lastError': lastError,
  };
}

List<String> _sensorLines(Iterable<String> values) => [
  for (final value in values)
    if (value.contains(_sensorCapability)) value,
];

bool _sameLines(List<String> first, List<String> second) {
  if (first.length != second.length) return false;
  for (var index = 0; index < first.length; index++) {
    if (first[index] != second[index]) return false;
  }
  return true;
}

bool _isNonIdleSensorLine(String value) {
  final lower = value.toLowerCase();
  return !lower.contains('not requested') &&
      !lower.contains('waiting for host.response');
}

bool _isStructuredSensorLine(String value) {
  final lower = value.toLowerCase();
  return _structuredSensorResult.hasMatch(value) ||
      lower.contains('permission_denied') ||
      lower.contains('permission denied') ||
      lower.contains('host_error') ||
      lower.contains('hardware_') ||
      lower.contains('unsupported') ||
      lower.contains('unavailable') ||
      lower.contains('denied');
}

Future<PocketSystemInstanceSnapshot> _systemUi(
  WidgetTester tester,
  PocketSystemHostController host,
) async {
  for (var attempt = 0; attempt < 100; attempt++) {
    final matches = host.instances.where((entry) => entry.isSystemUI);
    if (matches.isNotEmpty && matches.single.firstFrameReady) {
      return matches.single;
    }
    await tester.pump(const Duration(milliseconds: 30));
  }
  fail(
    'SystemUI was not ready; instances=${host.instances.map((entry) => '${entry.appId}:${entry.ready}:${entry.firstFrameReady}:${entry.session.failure}').toList()}; texts=${guest.texts(tester)}',
  );
}

Future<_SensorReadObservation> _readSensors(
  WidgetTester tester,
  PocketSession session,
  String attempt,
) async {
  final point = await guest.reveal(tester, 'Read sensors');
  final beforePaintedTexts = guest.texts(tester);
  final before = _sensorLines(beforePaintedTexts);
  final initialLastError = session.lastError;
  final gesture = await tester.startGesture(point);
  await tester.pump(const Duration(milliseconds: 50));
  await gesture.up();

  var sawLoading = false;
  var terminal = false;
  var returnedToReadButton = false;
  var resultNonIdle = false;
  var structuredResult = false;
  var current = beforePaintedTexts;
  var currentSensorLines = _sensorLines(current);

  // The pointer action is real JS input. Capture the loading state when it is
  // painted, then wait for the same request to return to a button/result
  // state. A native unsupported/denied response is still a valid structured
  // terminal result; a Pocket session failure is never accepted.
  for (var poll = 0; poll < _sensorPollLimit; poll++) {
    current = guest.texts(tester);
    currentSensorLines = _sensorLines(current);
    sawLoading =
        sawLoading ||
        current.contains('Reading') ||
        currentSensorLines.any(
          (line) => line.toLowerCase().contains('waiting for host.response'),
        );
    returnedToReadButton = current.contains('Read sensors');
    resultNonIdle = currentSensorLines.any(_isNonIdleSensorLine);
    structuredResult = currentSensorLines.any(_isStructuredSensorLine);

    final changedAfterTap = !_sameLines(before, currentSensorLines);
    final lastErrorChanged = session.lastError != initialLastError;
    if (session.failure != null || lastErrorChanged) break;
    if (returnedToReadButton &&
        resultNonIdle &&
        structuredResult &&
        (sawLoading || changedAfterTap)) {
      terminal = true;
      break;
    }
    await tester.pump(_sensorPollPeriod);
  }

  return _SensorReadObservation(
    attempt: attempt,
    terminal: terminal,
    sawLoading: sawLoading,
    returnedToReadButton: returnedToReadButton,
    resultNonIdle: resultNonIdle,
    structuredResult: structuredResult,
    sensorLines: currentSensorLines,
    paintedTexts: current,
    initialLastError: initialLastError,
    sessionFailure: session.failure?.toString(),
    lastError: session.lastError,
  );
}

void _expectSensorRead(
  _SensorReadObservation observation,
  PocketSession session,
  String? expectedLastError,
) {
  expect(
    session.failure,
    isNull,
    reason:
        'sensor ${observation.attempt} must not turn a supported=false or '
        'permission-denied response into a Guest exception: '
        '${observation.sessionFailure}; paintedTexts=${observation.paintedTexts}',
  );
  expect(
    observation.lastError,
    expectedLastError,
    reason:
        'sensor ${observation.attempt} must not raise a guest runtime error; '
        'initialLastError=${observation.initialLastError}; '
        'lastError=${observation.lastError}; '
        'paintedTexts=${observation.paintedTexts}',
  );
  expect(
    observation.terminal,
    isTrue,
    reason:
        'sensor ${observation.attempt} did not reach a terminal JS result; '
        'observation=${observation.toReport()}',
  );
  expect(
    observation.returnedToReadButton,
    isTrue,
    reason: 'sensor ${observation.attempt} must leave Reading state',
  );
  expect(
    observation.resultNonIdle,
    isTrue,
    reason: 'sensor ${observation.attempt} must paint a non-idle result',
  );
  expect(
    observation.structuredResult,
    isTrue,
    reason: 'sensor ${observation.attempt} must paint a structured result',
  );
}

void main() {
  final binding = IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  binding.framePolicy = LiveTestWidgetsFlutterBindingFramePolicy.fullyLive;

  testWidgets('real Hardware sensors request survives the guest lifecycle', (
    tester,
  ) async {
    final host = PocketSystemHostController();
    final report = <String, Object?>{
      'flow':
          'Home -> Hardware -> Connectivity -> Read sensors x2 -> Home -> +1',
      'directMethodChannel': false,
      'permissionRequestIssued': false,
    };
    PocketSystemInstanceSnapshot? systemUi;
    try {
      await tester.pumpWidget(PocketHostApp(systemController: host));
      await guest.waitFor(tester, '00');
      final activeSystemUi = await _systemUi(tester, host);
      systemUi = activeSystemUi;
      expect(activeSystemUi.session.failure, isNull);
      final initialLastError = activeSystemUi.session.lastError;
      report['initialLastError'] = initialLastError;

      await guest.tapGuest(tester, 'Hardware');
      await guest.waitFor(tester, 'Hardware');

      final first = await _readSensors(tester, activeSystemUi.session, 'first');
      report['first'] = first.toReport();
      _expectSensorRead(first, activeSystemUi.session, initialLastError);

      final second = await _readSensors(
        tester,
        activeSystemUi.session,
        'second',
      );
      report['second'] = second.toReport();
      _expectSensorRead(second, activeSystemUi.session, initialLastError);

      await guest.tapGuest(tester, 'Home', scroll: false);
      await guest.waitFor(tester, '00');
      await guest.tapGuest(tester, '+1', scroll: false);
      await guest.waitFor(tester, '01');
      expect(activeSystemUi.session.failure, isNull);
      expect(activeSystemUi.session.lastError, initialLastError);
      report['returnedHomeAndIncremented'] = true;
    } finally {
      report['finalPaintedTexts'] = guest.texts(tester);
      report['sessionFailure'] = systemUi?.session.failure?.toString();
      report['lastError'] = systemUi?.session.lastError;
      binding.reportData ??= <String, dynamic>{};
      binding.reportData!['hardwareSensorRegression'] = report;
      await tester.pumpWidget(const SizedBox.shrink());
      await tester.pump();
    }
  });
}
