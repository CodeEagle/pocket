import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:pocket_sdk/pocket_sdk.dart';

void main() {
  group('PerformanceHistory', () {
    test('keeps a bounded chronological window and recent low FPS', () async {
      final directory = await Directory.systemTemp.createTemp(
        'pocket-performance-',
      );
      final history = PerformanceHistory(
        file: File('${directory.path}/history.json'),
      );
      await history.initialize();
      try {
        for (var index = 0; index < 601; index++) {
          history.add(_sample(index, fps: index == 600 ? 8 : 60));
        }
        final snapshot = history.snapshot(limit: 60);
        final records = snapshot['history'] as List;
        expect(records, hasLength(60));
        expect((records.first as Map)['timestamp'], _timestamp(541));
        expect((records.last as Map)['timestamp'], _timestamp(600));
        expect((snapshot['latest'] as Map)['fps'], 8);
        expect((snapshot['latest'] as Map)['minFps'], 8);
      } finally {
        await history.dispose();
        await directory.delete(recursive: true);
      }
    });

    test('persists JSON and restores only the newest 600 samples', () async {
      final directory = await Directory.systemTemp.createTemp(
        'pocket-performance-',
      );
      final file = File('${directory.path}/nested/history.json');
      try {
        final first = PerformanceHistory(file: file);
        await first.initialize();
        for (var index = 0; index < 601; index++) {
          first.add(_sample(index, fps: 30 + (index % 10)));
        }
        await first.flush();
        final persisted = jsonDecode(await file.readAsString()) as Map;
        expect(persisted['history'], hasLength(600));
        await first.dispose();

        final restored = PerformanceHistory(file: file);
        await restored.initialize();
        final records = restored.snapshot(limit: 600)['history'] as List;
        expect(records, hasLength(600));
        expect((records.first as Map)['timestamp'], _timestamp(1));
        expect((records.last as Map)['timestamp'], _timestamp(600));
        await restored.dispose();
      } finally {
        await directory.delete(recursive: true);
      }
    });

    test('does not write non-finite or out-of-range numbers', () async {
      final directory = await Directory.systemTemp.createTemp(
        'pocket-performance-',
      );
      final file = File('${directory.path}/history.json');
      final history = PerformanceHistory(file: file);
      await history.initialize();
      try {
        history.add(_sample(0, fps: double.nan));
        history.add(_sample(1, fps: double.infinity));
        history.add(_sample(2, fps: 1001));
        await history.flush();
        expect((history.snapshot()['history'] as List), isEmpty);
        final contents = await file.readAsString();
        expect(contents, isNot(contains('NaN')));
        expect(contents, isNot(contains('Infinity')));
      } finally {
        await history.dispose();
        await directory.delete(recursive: true);
      }
    });

    test('keeps memory history and captures periodic write failures', () async {
      final directory = await Directory.systemTemp.createTemp(
        'pocket-performance-',
      );
      final blocker = File('${directory.path}/not-a-directory');
      await blocker.writeAsString('block writes below this path');
      final history = PerformanceHistory(
        file: File('${blocker.path}/history.json'),
      );
      await history.initialize();
      try {
        for (var index = 0; index < 10; index++) {
          history.add(_sample(index, fps: 24));
        }
        // The tenth sample schedules an unawaited periodic flush. Give its
        // serialized operation a turn so the error is captured rather than
        // reported as an unhandled future.
        await Future<void>.delayed(const Duration(milliseconds: 10));
        expect((history.snapshot()['history'] as List), hasLength(10));
        expect(history.snapshot()['logError'], isNotNull);

        await expectLater(history.flush(), throwsA(isA<FileSystemException>()));
        await history.dispose();
        expect((history.snapshot()['history'] as List), hasLength(10));
        expect(history.snapshot()['logError'], isNotNull);
      } finally {
        await directory.delete(recursive: true);
      }
    });
  });
}

Map<String, dynamic> _sample(int index, {required num fps}) =>
    <String, dynamic>{
      'timestamp': _timestamp(index),
      'fps': fps,
      'frames': 60,
      'durationMs': 1000,
      'maxGapMs': fps < 30 ? 90 : 18,
      'slowFrames': fps < 30 ? 4 : 0,
      'nativeMsP95': fps < 30 ? 12 : 3,
      'refreshHz': 60,
    };

String _timestamp(int index) =>
    DateTime.utc(2026, 1, 1).add(Duration(seconds: index)).toIso8601String();
