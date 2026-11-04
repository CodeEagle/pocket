import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:pocket_flutter/pocket_flutter.dart'
    show debugPocketFrameDeltaAtOverride, pocketFrameDeltaAt;
import 'package:pocket_host/main.dart';
import 'package:pocket_sdk/pocket_sdk.dart';

import 'guest_interaction_test.dart' as guest;

const _sensorCapability = 'hardware.sensors.read';
const _sensorUiCapability = 'Sensor read';
const _sensorPollPeriod = Duration(milliseconds: 50);
const _sensorPollLimit = 200;

final _structuredSensorResult = RegExp(
  r'"ok"\s*:\s*(?:true|false)|'
  r'"(?:errorCode|code|status)"\s*:',
  caseSensitive: false,
);

final _sensorAxisField = RegExp(
  r'"(?:accel|gravity|gyro)(?:X|Y|Z)"\s*:\s*'
  r'-?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?|'
  r'"(?:pitch|roll|yaw|pressureHpa|relativeAltitudeM)"\s*:\s*'
  r'-?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?',
  caseSensitive: false,
);

const _sensorAxisNames = <String>{
  'accelX',
  'accelY',
  'accelZ',
  'gravityX',
  'gravityY',
  'gravityZ',
  'gyroX',
  'gyroY',
  'gyroZ',
  'pitch',
  'roll',
  'yaw',
  'pressureHpa',
  'relativeAltitudeM',
};

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

final class _SensorRecordingEvidence {
  const _SensorRecordingEvidence({
    required this.requests,
    required this.responses,
  });

  final List<Map<String, Object?>> requests;
  final List<Map<String, Object?>> responses;

  Map<String, Object?> toReport() => <String, Object?>{
    // The test-only frame seam observes the live host.request before the
    // frame is returned. PocketRecording then supplies the durable response
    // entry; Flutter's host.response sender intentionally correlates only by
    // requestId, so capability is joined from that live request rather than
    // guessed from the response payload.
    'transport':
        'liveFrameHostRequestByRequestId+recording.hostResponseSendEntry',
    'requestPayloadRetainedByRecordingSchema': false,
    'requests': requests,
    'responses': responses,
  };
}

_SensorRecordingEvidence _sensorRecordingEvidence(
  Map<String, PocketRecording> recordings,
  List<Map<String, Object?>> observedRequests,
) {
  final responsesById = <String, List<Map<String, Object?>>>{};

  for (final recordingEntry in recordings.entries) {
    final runtimeId = recordingEntry.key;
    for (final entry in recordingEntry.value.entries) {
      if (entry.kind != 'send') continue;
      final message = entry.args['message'];
      if (message is! Map || message['name'] != 'host.response') continue;
      final payload = message['payload'];
      if (payload is! Map || payload['requestId'] is! String) continue;
      final requestId = payload['requestId'] as String;
      if (requestId.isEmpty) continue;
      final responseCapability = payload['capability'] is String
          ? payload['capability'] as String
          : null;
      final rawError = payload['error'];
      final errorCode = rawError is Map && rawError['code'] is String
          ? rawError['code'] as String
          : null;
      final rawResult = payload['result'];
      final result = rawResult is Map
          ? <String, Object?>{
              for (final item in rawResult.entries)
                if (item.key is String) item.key as String: item.value,
            }
          : null;
      final realSensors = result?['realSensors'] == true;
      responsesById.putIfAbsent(requestId, () => <Map<String, Object?>>[]).add(
        <String, Object?>{
          'runtimeId': runtimeId,
          'entryIndex': entry.index,
          'requestId': requestId,
          // PocketSystemHost._respond() does not repeat capability. Keep
          // the optional field only to detect a future protocol mismatch;
          // the authoritative capability is joined from the live request
          // below by its requestId.
          'responseCapability': responseCapability,
          'ok': payload['ok'],
          'errorCode': errorCode,
          'realSensors': realSensors,
          'hasResult': payload.containsKey('result'),
          'hasError': payload.containsKey('error'),
          'result': result,
        },
      );
    }
  }

  final responses = <Map<String, Object?>>[];
  for (var sequence = 0; sequence < observedRequests.length; sequence++) {
    final request = observedRequests[sequence];
    final requestId = request['requestId'];
    if (requestId is! String) continue;
    final matches = responsesById[requestId] ?? const <Map<String, Object?>>[];
    if (matches.length == 1) {
      responses.add(<String, Object?>{
        ...matches.single,
        'requestSequence': sequence,
        'requestRuntimeIdentity': request['runtimeIdentity'],
        'requestCapability': request['capability'],
      });
    } else {
      responses.add(<String, Object?>{
        'requestId': requestId,
        'requestSequence': sequence,
        'requestRuntimeIdentity': request['runtimeIdentity'],
        'matchingResponseCount': matches.length,
      });
    }
  }
  return _SensorRecordingEvidence(
    requests: List<Map<String, Object?>>.unmodifiable(observedRequests),
    responses: List<Map<String, Object?>>.unmodifiable(responses),
  );
}

void _expectSensorRecordingEvidence(_SensorRecordingEvidence evidence) {
  expect(
    evidence.requests,
    hasLength(2),
    reason:
        'the two real sensor taps must produce two observed host.request '
        'events; '
        'evidence=${evidence.toReport()}',
  );
  expect(
    evidence.responses,
    hasLength(2),
    reason:
        'each observed sensor request must have a matching host.response; '
        'evidence=${evidence.toReport()}',
  );
  final requestIds = evidence.requests
      .map((response) => response['requestId'])
      .whereType<String>()
      .toSet();
  expect(
    requestIds,
    hasLength(2),
    reason:
        'sensor taps must use distinct request IDs; evidence=${evidence.toReport()}',
  );
  expect(
    evidence.requests.map((request) => request['capability']).toSet(),
    equals(<String>{_sensorCapability}),
    reason:
        'live host.request evidence must identify both sensor capability '
        'requests; evidence=${evidence.toReport()}',
  );
  expect(
    evidence.responses
        .map((response) => response['requestRuntimeIdentity'])
        .toSet(),
    hasLength(1),
    reason:
        'both observed sensor requests must belong to the same runtime; '
        'evidence=${evidence.toReport()}',
  );
  final responseIds = evidence.responses
      .map((response) => response['requestId'])
      .whereType<String>()
      .toSet();
  expect(
    responseIds,
    equals(requestIds),
    reason:
        'response IDs must exactly match observed sensor request IDs; '
        'evidence=${evidence.toReport()}',
  );
  final responseRuntimeIds = evidence.responses
      .map((response) => response['runtimeId'])
      .whereType<String>()
      .toSet();
  expect(
    responseRuntimeIds,
    hasLength(1),
    reason:
        'both sensor responses must belong to the same recorded runtime; '
        'evidence=${evidence.toReport()}',
  );
  for (var index = 0; index < evidence.responses.length; index++) {
    final response = evidence.responses[index];
    expect(
      response['matchingResponseCount'],
      isNull,
      reason:
          'each observed sensor request must have exactly one host.response; '
          'evidence=${evidence.toReport()}',
    );
    expect(
      response['requestId'],
      isA<String>(),
      reason: 'sensor response must carry the observed guest requestId',
    );
    expect(
      response['requestCapability'],
      _sensorCapability,
      reason:
          'the live host.request paired by requestId must carry the sensor '
          'capability; response=$response',
    );
    expect(
      response['responseCapability'] == null ||
          response['responseCapability'] == _sensorCapability,
      isTrue,
      reason:
          'host.response capability, when present, must not contradict the '
          'paired live request; response=$response',
    );
    expect(
      response['ok'],
      isA<bool>(),
      reason: 'host.response must carry an explicit ok flag',
    );
    expect(
      response['hasResult'] == true || response['hasError'] == true,
      isTrue,
      reason:
          'unsupported/permission-denied is valid only as a structured '
          'result/error; response=$response',
    );
    if (response['ok'] == true) {
      expect(
        response['hasError'],
        isFalse,
        reason: 'a successful sensor response must not carry an error',
      );
      expect(
        response['realSensors'],
        isTrue,
        reason:
            'a successful sensor response must be marked realSensors=true; '
            'response=$response',
      );
      final result = response['result'];
      final axisCount = result is Map
          ? result.entries
                .where(
                  (entry) =>
                      _sensorAxisNames.contains(entry.key) &&
                      entry.value is num &&
                      (entry.value as num).isFinite,
                )
                .length
          : 0;
      expect(
        axisCount,
        greaterThanOrEqualTo(3),
        reason:
            'a successful sensor response must retain real numeric axis '
            'fields; response=$response',
      );
    } else {
      expect(
        response['realSensors'],
        isNot(true),
        reason: 'an unsuccessful sensor response cannot be realSensors=true',
      );
    }
    if (index == 0) continue;
    expect(
      (response['entryIndex']! as int) >
          (evidence.responses[index - 1]['entryIndex']! as int),
      isTrue,
      reason:
          'recorded host.responses must follow the observed request order; '
          'evidence=${evidence.toReport()}',
    );
  }
}

bool _isSensorUiLine(String value) {
  final lower = value.toLowerCase();
  return value == _sensorUiCapability ||
      value == 'Not requested' ||
      value.startsWith('Waiting for host response') ||
      value.startsWith('Waiting for host.response') ||
      value == 'Live host result' ||
      value.startsWith('Motion ') ||
      value.startsWith('Pressure ') ||
      value.startsWith('Status · ') ||
      lower.contains('hardware_') ||
      lower.contains('permission denied') ||
      lower.contains('unsupported') ||
      lower.contains('unavailable') ||
      lower.contains('denied');
}

List<String> _sensorLines(Iterable<String> values) {
  final all = values.toList(growable: false);
  // Keep compatibility with recordings made by the previous capability
  // renderer. New HardwareResult output is deliberately human-readable and
  // is scoped from the Sensor read marker to the following BLE result.
  final legacy = [
    for (final value in all)
      if (value.contains(_sensorCapability)) value,
  ];
  if (legacy.isNotEmpty) return legacy;
  final marker = all.indexOf(_sensorUiCapability);
  if (marker < 0) return const <String>[];
  final lines = <String>[];
  for (var index = marker; index < all.length; index++) {
    final value = all[index];
    if (index > marker && value == 'BLE connect') break;
    if (_isSensorUiLine(value)) lines.add(value);
  }
  return lines;
}

bool _sameLines(List<String> first, List<String> second) {
  if (first.length != second.length) return false;
  for (var index = 0; index < first.length; index++) {
    if (first[index] != second[index]) return false;
  }
  return true;
}

bool _isNonIdleSensorLine(String value) {
  final lower = value.toLowerCase();
  return !lower.contains('sensor read') &&
      !lower.contains('not requested') &&
      !lower.contains('waiting for host.response') &&
      !lower.contains('waiting for host response');
}

bool _isStructuredSensorLine(String value) {
  final lower = value.toLowerCase();
  return _structuredSensorResult.hasMatch(value) ||
      (value.startsWith('$_sensorCapability · {') &&
          _sensorAxisField.allMatches(value).length >= 3) ||
      lower.contains('live host result') ||
      lower.startsWith('motion ') ||
      lower.startsWith('pressure ') ||
      lower.startsWith('status · ') ||
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
  // Let the real guest turn consume the pointer-up before sampling the
  // painted result. This mirrors guest.tapGuest's settled tap window while
  // keeping the observation loop independent from any text transition.
  await tester.pump(const Duration(milliseconds: 550));
  // The result card is below the Connectivity button on the phone-sized
  // viewport. Make the structured response visible before sampling texts;
  // draw-op culling must not turn a real native result into an empty sample.
  await guest.reveal(tester, 'Sensors');

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
  String? expectedLastError, {
  bool requireTerminal = true,
}) {
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
  if (requireTerminal) {
    expect(
      observation.terminal,
      isTrue,
      reason:
          'sensor ${observation.attempt} did not reach a terminal JS result; '
          'observation=${observation.toReport()}',
    );
  }
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
    final recordings = PocketRecordingLibrary()..start();
    final report = <String, Object?>{
      'flow':
          'Home -> Hardware -> Connectivity -> Read sensors x2 -> Home -> +1',
      'directMethodChannel': false,
      'permissionRequestIssued': false,
    };
    PocketSystemInstanceSnapshot? systemUi;
    Map<String, PocketRecording>? stoppedRecordings;
    final observedRequests = <Map<String, Object?>>[];
    final previousFrameDeltaOverride = debugPocketFrameDeltaAtOverride;
    var requestSequence = 0;
    debugPocketFrameDeltaAtOverride = (runtime, deltaMilliseconds) {
      final frame = pocketFrameDeltaAt(runtime, deltaMilliseconds);
      if (frame != null) {
        for (final event in frame.events) {
          if (event.method != 'host.request' ||
              event.params['capability'] != _sensorCapability) {
            continue;
          }
          final requestId = event.params['requestId'];
          if (requestId is! String || requestId.isEmpty) continue;
          observedRequests.add(<String, Object?>{
            'sequence': requestSequence++,
            'runtimeIdentity': identityHashCode(runtime),
            'requestId': requestId,
            'capability': event.params['capability'],
          });
        }
      }
      return frame;
    };
    try {
      await tester.pumpWidget(
        PocketHostApp(systemController: host, recordings: recordings),
      );
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
      // An unsupported native provider can return the same already-painted
      // structured result synchronously. UI text therefore cannot prove that
      // this tap reached the provider; the recording evidence below is the
      // authoritative second-call check.
      _expectSensorRead(
        second,
        activeSystemUi.session,
        initialLastError,
        requireTerminal: false,
      );

      final frozenRecordings = recordings.stop();
      stoppedRecordings = frozenRecordings;
      final sensorEvidence = _sensorRecordingEvidence(
        frozenRecordings,
        observedRequests,
      );
      report['recording'] = sensorEvidence.toReport();
      _expectSensorRecordingEvidence(sensorEvidence);

      await guest.tapGuest(tester, 'Home', scroll: false);
      await guest.waitFor(tester, '00');
      await guest.tapGuest(tester, '+1', scroll: false);
      await guest.waitFor(tester, '01');
      expect(activeSystemUi.session.failure, isNull);
      expect(activeSystemUi.session.lastError, initialLastError);
      report['returnedHomeAndIncremented'] = true;
    } finally {
      debugPocketFrameDeltaAtOverride = previousFrameDeltaOverride;
      report['finalPaintedTexts'] = guest.texts(tester);
      report['sessionFailure'] = systemUi?.session.failure?.toString();
      report['lastError'] = systemUi?.session.lastError;
      if (stoppedRecordings == null) {
        try {
          final frozenRecordings = recordings.stop();
          stoppedRecordings = frozenRecordings;
          report['recording'] = _sensorRecordingEvidence(
            frozenRecordings,
            observedRequests,
          ).toReport();
        } on Object catch (error) {
          report['recordingStopError'] = '$error';
        }
      }
      binding.reportData ??= <String, dynamic>{};
      binding.reportData!['hardwareSensorRegression'] = report;
      await tester.pumpWidget(const SizedBox.shrink());
      await tester.pump();
    }
  });
}
