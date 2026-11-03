import 'dart:io';

import 'package:integration_test/integration_test_driver.dart';

Future<void> main() async {
  // Do not let a failed attach or a test that never returns a response leave
  // the previous run's JSON looking like evidence for this invocation.
  final output = File(
    '$testOutputsDirectory${Platform.pathSeparator}integration_response_data.json',
  );
  if (await output.exists()) await output.delete();

  // The Flutter driver keeps its non-zero exit code on failure while also
  // persisting the current run's reportData for diagnosis.
  await integrationDriver(writeResponseOnFailure: true);
}
