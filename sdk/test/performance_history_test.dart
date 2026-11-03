import 'dart:io';

import 'package:pocket_sdk/pocket_sdk.dart';
import 'package:test/test.dart';

Map<String, dynamic> _sample({
  required String timestamp,
  required double fps,
  required double refreshHz,
}) => <String, dynamic>{
  'timestamp': timestamp,
  'fps': fps,
  'frames': fps.round(),
  'durationMs': 1000,
  'maxGapMs': 1000 / refreshHz,
  'slowFrames': 0,
  'nativeMsP95': 1.25,
  'refreshHz': refreshHz,
};

void main() {
  test(
    'retains real high-refresh FPS in memory and persisted history',
    () async {
      final directory = await Directory.systemTemp.createTemp(
        'pocket-performance-history-',
      );
      addTearDown(() => directory.delete(recursive: true));
      final file = File('${directory.path}/history.json');

      final history = PerformanceHistory(file: file, namespace: 'test');
      history.add(
        _sample(timestamp: '2026-11-03T00:00:00Z', fps: 120, refreshHz: 120),
      );
      history.add(
        _sample(timestamp: '2026-11-03T00:00:01Z', fps: 144, refreshHz: 144),
      );

      final snapshot = history.snapshot(limit: 2);
      expect(snapshot['history'], hasLength(2));
      expect((snapshot['latest'] as Map)['fps'], 144);
      expect((snapshot['latest'] as Map)['refreshHz'], 144);
      expect((snapshot['latest'] as Map)['minFps'], 120);
      await history.flush();

      final restored = PerformanceHistory(file: file, namespace: 'test');
      await restored.initialize();
      final restoredSnapshot = restored.snapshot(limit: 2);
      expect(
        (restoredSnapshot['history'] as List).map(
          (item) => (item as Map)['fps'],
        ),
        [120, 144],
      );
      expect(
        (restoredSnapshot['history'] as List).map(
          (item) => (item as Map)['refreshHz'],
        ),
        [120, 144],
      );
      await history.dispose();
      await restored.dispose();
    },
  );

  test('rejects only out-of-contract FPS values without a 60 ceiling', () {
    final history = PerformanceHistory(
      file: File(
        '${Directory.systemTemp.path}/unused-performance-history.json',
      ),
    );
    history.add(
      _sample(timestamp: '2026-11-03T00:00:02Z', fps: 90, refreshHz: 90),
    );
    history.add(
      _sample(timestamp: '2026-11-03T00:00:03Z', fps: 240, refreshHz: 240),
    );
    final snapshot = history.snapshot();
    expect((snapshot['history'] as List), hasLength(2));
    expect((snapshot['history'] as List).last['fps'], 240);
  });
}
