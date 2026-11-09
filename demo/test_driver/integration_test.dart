import 'dart:io';

import 'package:integration_test/integration_test_driver.dart';

/// Fails the host driver when an app declares mandatory test milestones but
/// the integration response never reports them as complete.
///
/// Older tests do not declare `pocketAcceptance`, so their report contract is
/// unchanged. If the key is present, require both arrays and validate their
/// contents rather than treating a malformed declaration as an opt-out.
void validatePocketAcceptanceCheckpoints(Map<String, dynamic>? reportData) {
  if (reportData == null || !reportData.containsKey('pocketAcceptance')) {
    return;
  }

  final acceptance = reportData['pocketAcceptance'];
  if (acceptance is! Map) {
    throw StateError('pocketAcceptance must be an object.');
  }

  final rawRequired = acceptance['required'];
  final rawCompleted = acceptance['completed'];
  if (rawRequired is! List || rawCompleted is! List) {
    throw StateError(
      'pocketAcceptance must contain required and completed arrays.',
    );
  }

  final required = _checkpointIds(rawRequired, 'required');
  final completed = _checkpointIds(rawCompleted, 'completed');
  final missing = required.where(
    (checkpoint) => !completed.contains(checkpoint),
  );
  if (missing.isNotEmpty) {
    throw StateError(
      'Required pocketAcceptance checkpoints were not completed: '
      '${missing.join(', ')}.',
    );
  }
}

List<String> _checkpointIds(List<dynamic> values, String field) {
  final ids = <String>[];
  final seen = <String>{};
  for (final value in values) {
    if (value is! String || value.trim().isEmpty) {
      throw StateError(
        'pocketAcceptance.$field must contain non-empty strings.',
      );
    }
    if (!seen.add(value)) {
      throw StateError('pocketAcceptance.$field contains duplicate "$value".');
    }
    ids.add(value);
  }
  return ids;
}

Future<void> main() async {
  // Do not let a failed attach or a test that never returns a response leave
  // the previous run's JSON looking like evidence for this invocation.
  final output = File(
    '$testOutputsDirectory${Platform.pathSeparator}integration_response_data.json',
  );
  if (await output.exists()) await output.delete();

  // Keep the current response on failure for diagnosis. Write it before
  // validating the optional completion contract so even a missing checkpoint
  // leaves the response that caused this driver run to fail.
  await integrationDriver(
    writeResponseOnFailure: true,
    responseDataCallback: (reportData) async {
      await writeResponseData(reportData);
      validatePocketAcceptanceCheckpoints(reportData);
    },
  );
}
