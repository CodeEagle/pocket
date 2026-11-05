import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:pocket_sdk/pocket_sdk.dart';

// Produce this archive through editor/test/preview_recording.test.ts first.
// This cross-host check deliberately uses the existing SDK loader and native
// replay runner, independently of the editor's TypeScript replay projection.
void main() {
  final path = Platform.environment['POCKET_PREVIEW_RECORDING_ARCHIVE'];
  final native = Platform.environment['POCKET_NATIVE_LIBRARY'];
  test(
    'web preview archive replays through the canonical SDK native runner',
    () async {
      final result = await PocketRecordingLibrary.replayArchive(File(path!));
      expect(result['ok'], isTrue, reason: '$result');
      expect(result['runtimes'], isA<Map>(), reason: '$result');
      expect((result['runtimes'] as Map).isNotEmpty, isTrue, reason: '$result');
    },
    skip: path == null || native == null
        ? 'Set POCKET_PREVIEW_RECORDING_ARCHIVE and POCKET_NATIVE_LIBRARY.'
        : false,
  );
}
