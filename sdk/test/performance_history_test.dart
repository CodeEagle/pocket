import 'dart:convert';
import 'dart:io';

import 'package:pocket_sdk/pocket_sdk.dart';
import 'package:test/test.dart';

Map<String, dynamic> _sample({
  required String timestamp,
  required double fps,
  required double refreshHz,
  List<Map<String, dynamic>> longFrameEvents = const <Map<String, dynamic>>[],
}) => <String, dynamic>{
  'timestamp': timestamp,
  'fps': fps,
  'frames': fps.round(),
  'durationMs': 1000,
  'maxGapMs': 1000 / refreshHz,
  'slowFrames': 0,
  'nativeMsP95': 1.25,
  'refreshHz': refreshHz,
  if (longFrameEvents.isNotEmpty) 'longFrameEvents': longFrameEvents,
};

Map<String, dynamic> _eventOnlySample({
  required String timestamp,
  required Map<String, dynamic> event,
}) => <String, dynamic>{
  'timestamp': timestamp,
  'fps': 0,
  'frames': 0,
  'durationMs': 0,
  'maxGapMs': 0,
  'slowFrames': 0,
  'nativeMsP95': 0,
  'refreshHz': 60,
  'longFrameEvents': <Map<String, dynamic>>[event],
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

  test('persists bounded active long-frame facts with JS context', () async {
    final directory = await Directory.systemTemp.createTemp(
      'pocket-performance-jank-',
    );
    addTearDown(() => directory.delete(recursive: true));
    final file = File('${directory.path}/history.json');
    final event = <String, dynamic>{
      'timestamp': '2026-11-03T00:00:04.250Z',
      'refreshHz': 120,
      'budgetMs': 8.333333,
      'buildMs': 15.5,
      'rasterMs': 3.25,
      'nativeMs': 11.75,
      'activeGapMs': 20.0,
      'active': true,
    };

    final history = PerformanceHistory(file: file);
    history.setContext('feed.scroll');
    history.add(
      _sample(
        timestamp: '2026-11-03T00:00:04Z',
        fps: 120,
        refreshHz: 120,
        longFrameEvents: <Map<String, dynamic>>[event],
      ),
    );
    final snapshot = history.snapshot(eventLimit: 4);
    expect(snapshot['longFrameEvents'], hasLength(1));
    expect((snapshot['longFrameEvents'] as List).single, <String, dynamic>{
      ...event,
      'context': 'feed.scroll',
    });
    expect((snapshot['latest'] as Map)['longFrameCount'], 1);

    await history.flush();
    final restored = PerformanceHistory(file: file);
    await restored.initialize();
    expect(
      (restored.snapshot(eventLimit: 4)['longFrameEvents'] as List).single,
      <String, dynamic>{...event, 'context': 'feed.scroll'},
    );
    await history.dispose();
    await restored.dispose();
  });

  test('does not infer jank from a sparse idle FPS sample', () {
    final history = PerformanceHistory(
      file: File(
        '${Directory.systemTemp.path}/unused-sparse-performance-history.json',
      ),
    );
    history.add(
      _sample(timestamp: '2026-11-03T00:00:05Z', fps: 5.0, refreshHz: 120),
    );
    final snapshot = history.snapshot();
    expect((snapshot['history'] as List).single['fps'], 5.0);
    expect(snapshot['longFrameEvents'], isEmpty);
    history.addLongFrameEvent(<String, dynamic>{
      'timestamp': '2026-11-03T00:00:05.500Z',
      'refreshHz': 120,
      'budgetMs': 8.3333,
      'activeGapMs': 1000,
      'active': false,
    });
    expect(history.snapshot()['longFrameEvents'], isEmpty);
  });

  test(
    'event-only burst persists jank without poisoning FPS history',
    () async {
      final event = <String, dynamic>{
        'timestamp': '2026-11-03T00:00:06.100Z',
        'refreshHz': 60,
        'budgetMs': 16.6667,
        'nativeMs': 40,
        'activeGapMs': 45,
        'active': true,
      };
      final history = PerformanceHistory(
        file: File(
          '${Directory.systemTemp.path}/unused-event-only-history.json',
        ),
      );
      history.add(
        _sample(timestamp: '2026-11-03T00:00:06Z', fps: 60, refreshHz: 60),
      );
      final added = history.add(
        _eventOnlySample(timestamp: '2026-11-03T00:00:06.200Z', event: event),
      );

      final snapshot = history.snapshot();
      expect(added, hasLength(1));
      expect(snapshot['history'], hasLength(1));
      expect((snapshot['latest'] as Map)['fps'], 60);
      expect((snapshot['latest'] as Map)['minFps'], 60);
      expect(snapshot['longFrameEvents'], hasLength(1));
      expect((snapshot['longFrameEvents'] as List).single['active'], isTrue);

      final initial = PerformanceHistory(
        file: File(
          '${Directory.systemTemp.path}/unused-event-only-initial-history.json',
        ),
      );
      initial.add(
        _eventOnlySample(
          timestamp: '2026-11-03T00:00:07.200Z',
          event: <String, dynamic>{
            ...event,
            'timestamp': '2026-11-03T00:00:07.100Z',
          },
        ),
      );
      final initialSnapshot = initial.snapshot();
      expect((initialSnapshot['latest'] as Map)['fps'], isNull);
      expect((initialSnapshot['latest'] as Map)['minFps'], isNull);
      expect(initialSnapshot['longFrameEvents'], hasLength(1));
      await history.dispose();
      await initial.dispose();
    },
  );

  test('restoring an old event-only point keeps FPS minimum valid', () async {
    final directory = await Directory.systemTemp.createTemp(
      'pocket-performance-history-restore-',
    );
    addTearDown(() => directory.delete(recursive: true));
    final file = File('${directory.path}/history.json');
    final event = <String, dynamic>{
      'timestamp': '2026-11-03T00:00:08.100Z',
      'refreshHz': 60,
      'budgetMs': 16.6667,
      'nativeMs': 40,
      'active': true,
    };
    await file.writeAsString(
      jsonEncode(<String, dynamic>{
        'version': 2,
        'history': <Map<String, dynamic>>[
          _sample(timestamp: '2026-11-03T00:00:08Z', fps: 60, refreshHz: 60),
          _eventOnlySample(timestamp: '2026-11-03T00:00:08.200Z', event: event),
        ],
        'longFrameEvents': <Map<String, dynamic>>[event],
      }),
    );

    final restored = PerformanceHistory(file: file);
    await restored.initialize();
    final snapshot = restored.snapshot();
    expect(snapshot['history'], hasLength(1));
    expect((snapshot['latest'] as Map)['fps'], 60);
    expect((snapshot['latest'] as Map)['minFps'], 60);
    expect(snapshot['longFrameEvents'], hasLength(1));
    await restored.dispose();
  });

  test(
    'bounds persisted long-frame events independently of FPS samples',
    () async {
      final history = PerformanceHistory(
        file: File(
          '${Directory.systemTemp.path}/unused-bounded-jank-history.json',
        ),
      );
      for (
        var index = 0;
        index < PerformanceHistory.maxLongFrameEvents + 7;
        index++
      ) {
        final minute = (index ~/ 60).toString().padLeft(2, '0');
        final second = (index % 60).toString().padLeft(2, '0');
        history.addLongFrameEvent(<String, dynamic>{
          'timestamp': '2026-11-03T00:$minute:$second.000Z',
          'refreshHz': 60,
          'budgetMs': 16.6667,
          'nativeMs': 30,
          'active': true,
        });
      }
      final events =
          history.snapshot(
                eventLimit: PerformanceHistory.maxLongFrameEvents,
              )['longFrameEvents']
              as List;
      expect(events, hasLength(PerformanceHistory.maxLongFrameEvents));
      expect(events.first['timestamp'], '2026-11-03T00:00:07.000Z');
      await history.dispose();
    },
  );

  test(
    'delayed Phase-2 enrichment updates buildMs/rasterMs while preserving original context',
    () async {
      final history = PerformanceHistory(
        file: File(
          '${Directory.systemTemp.path}/unused-enrichment-context-history.json',
        ),
      );
      history.setContext('route.feed');
      final phase1 = <String, dynamic>{
        'timestamp': '2026-11-03T00:10:00.250Z',
        'refreshHz': 120,
        'budgetMs': 8.333333,
        'nativeMs': 11.75,
        'activeGapMs': 20.0,
        'active': true,
      };
      history.add(
        _eventOnlySample(timestamp: '2026-11-03T00:10:00.300Z', event: phase1),
      );

      // User navigates to a different route before the engine FrameTiming batch arrives.
      history.setContext('route.settings');
      final phase2 = <String, dynamic>{
        'timestamp': '2026-11-03T00:10:00.250Z',
        'refreshHz': 120,
        'budgetMs': 8.333333,
        'buildMs': 15.5,
        'rasterMs': 3.25,
        'nativeMs': 11.75,
        'activeGapMs': 20.0,
        'active': true,
      };
      final enriched = history.add(
        _eventOnlySample(timestamp: '2026-11-03T00:10:00.900Z', event: phase2),
      );

      expect(enriched, hasLength(1));
      expect(enriched.single['context'], 'route.feed');
      expect(enriched.single['buildMs'], 15.5);
      expect(enriched.single['rasterMs'], 3.25);

      final events = history.snapshot()['longFrameEvents'] as List;
      expect(events, hasLength(1));
      expect(events.single, <String, dynamic>{
        ...phase2,
        'context': 'route.feed',
      });
      await history.dispose();
    },
  );

  test(
    'initialize restoring disk events does not stamp current context onto historical context-free events',
    () async {
      final directory = await Directory.systemTemp.createTemp(
        'pocket-performance-history-init-context-',
      );
      addTearDown(() => directory.delete(recursive: true));
      final file = File('${directory.path}/history.json');
      final historicalWithoutContext = <String, dynamic>{
        'timestamp': '2026-11-03T00:11:00.100Z',
        'refreshHz': 60,
        'budgetMs': 16.6667,
        'nativeMs': 35,
        'active': true,
      };
      final historicalPrePhase2 = <String, dynamic>{
        'timestamp': '2026-11-03T00:11:01.100Z',
        'refreshHz': 60,
        'budgetMs': 16.6667,
        'nativeMs': 22,
        'active': true,
        'context': 'route.original',
      };
      await file.writeAsString(
        jsonEncode(<String, dynamic>{
          'version': 2,
          'history': const <Map<String, dynamic>>[],
          'longFrameEvents': <Map<String, dynamic>>[
            historicalWithoutContext,
            historicalPrePhase2,
          ],
        }),
      );

      final restored = PerformanceHistory(file: file);
      restored.setContext('route.current_session');
      // Simulate an in-memory enrichment arriving before initialize() finishes reading disk.
      restored.addLongFrameEvent(<String, dynamic>{
        'timestamp': '2026-11-03T00:11:01.100Z',
        'refreshHz': 60,
        'budgetMs': 16.6667,
        'buildMs': 19.5,
        'rasterMs': 4.25,
        'nativeMs': 22,
        'active': true,
        'context': 'route.original',
      });
      await restored.initialize();

      final events =
          (restored.snapshot()['longFrameEvents'] as List)
              .cast<Map<String, dynamic>>();
      expect(events, hasLength(2));
      expect(events.first.containsKey('context'), isFalse);
      expect(events.last['context'], 'route.original');
      expect(events.last['buildMs'], 19.5);
      expect(events.last['rasterMs'], 4.25);
      await restored.dispose();
    },
  );
}
