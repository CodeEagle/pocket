import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:pocket_flutter/pocket_flutter.dart';

void main() {
  test('canonical JSON preserves negative zero in guest inputs', () {
    final encoded = pocketCanonicalJson({'value': -0.0, 'positive': 0.0});
    final restored = jsonDecode(encoded) as Map;
    expect((restored['value'] as num).isNegative, isTrue);
    expect((restored['positive'] as num).isNegative, isFalse);
  });

  test('recording JSON is bounded, canonical and round-trips', () {
    final controller = PocketRecordingController(maxEntries: 4, maxBytes: 4096);
    controller.start(
      PocketRecordingMetadata(
        width: 320,
        height: 480,
        density: 2,
        tickHz: 60,
        engineAbi: 'test-engine',
      ),
    );
    controller.add(
      PocketRecordingEntry(
        index: 0,
        kind: 'frame',
        args: const <String, dynamic>{'deltaMs': 16.5},
        result: <String, dynamic>{
          'frame': <String, dynamic>{'sha256': List.filled(64, 'a').join()},
        },
      ),
    );
    final recording = controller.snapshot();
    final restored = PocketRecording.fromJsonString(recording.toJsonString());
    expect(restored.entries, hasLength(1));
    expect(restored.metadata.tickHz, 60);
    expect(restored.toJsonString(), recording.toJsonString());
  });

  test('legacy pure UI recordings stay version 1 and remain readable', () {
    final controller = PocketRecordingController(maxEntries: 2, maxBytes: 4096);
    controller.start(
      PocketRecordingMetadata(width: 10, height: 10, density: 1, tickHz: 60),
    );
    controller.add(
      PocketRecordingEntry(
        index: 0,
        kind: 'frame',
        args: const <String, dynamic>{'deltaMs': 0},
        result: const <String, dynamic>{
          'traceClock': <String, dynamic>{
            'idleMs': <double>[],
            'scalars': <Object?>[],
          },
        },
      ),
    );

    final recording = controller.finish();
    expect(recording.version, 1);
    final restored = PocketRecording.fromJsonString(recording.toJsonString());
    expect(restored.version, 1);
    expect(restored.entries.single.result['traceClock'], {
      'idleMs': <double>[],
      'scalars': <Map<String, dynamic>>[],
    });
  });

  test(
    'capture stop preserves the legacy clock envelope and upgrades schema',
    () {
      final controller = PocketRecordingController(
        maxEntries: 2,
        maxBytes: 4096,
      );
      controller.start(
        PocketRecordingMetadata(width: 10, height: 10, density: 1, tickHz: 60),
      );
      controller.add(
        PocketRecordingEntry(
          index: 0,
          kind: 'captureStop',
          result: const <String, dynamic>{
            'captured': true,
            'traceClock': <String, dynamic>{
              'idleMs': <double>[],
              'scalars': <Object?>[],
            },
          },
        ),
      );

      final recording = controller.finish();
      expect(recording.version, 2);
      expect(recording.entries.single.result['traceClock'], {
        'idleMs': <double>[],
        'scalars': <Map<String, dynamic>>[],
      });
    },
  );

  test(
    'version 2 validates Worker/offload event lanes and upgrades controller',
    () {
      final envelope = pocketValidateTraceClockEnvelope({
        'version': 2,
        'idleMs': <double>[],
        'scalars': <Object?>[],
        'workerEvents': [
          {
            'seq': 1,
            'session': 'worker:1',
            'kind': 'bootstrap',
            'data': <String, Object?>{
              'bytes': <int>[0x50, 0x4a],
            },
          },
        ],
      });
      expect(envelope['version'], 2);
      expect((envelope['workerEvents'] as List), hasLength(1));

      final controller = PocketRecordingController(
        maxEntries: 2,
        maxBytes: 4096,
      );
      controller.start(
        PocketRecordingMetadata(width: 10, height: 10, density: 1, tickHz: 60),
      );
      controller.add(
        PocketRecordingEntry(
          index: 0,
          kind: 'frame',
          args: const <String, dynamic>{'deltaMs': 0},
          result: <String, dynamic>{'traceClock': envelope},
        ),
      );
      expect(controller.finish().version, 2);
    },
  );

  test('trace event lanes reject unknown, malformed and unordered fields', () {
    final validEvent = <String, dynamic>{
      'seq': 1,
      'session': 'worker:1',
      'kind': 'bootstrap',
      'data': <String, Object?>{},
    };
    Map<String, dynamic> envelope(Object event) => <String, dynamic>{
      'version': 2,
      'idleMs': <double>[],
      'scalars': <Object?>[],
      'workerEvents': <Object>[event],
    };
    expect(
      () => pocketValidateTraceClockEnvelope(
        envelope(<String, dynamic>{...validEvent, 'extra': true}),
      ),
      throwsA(isA<PocketRecordingFormatException>()),
    );
    expect(
      () => pocketValidateTraceClockEnvelope(
        envelope(<String, dynamic>{...validEvent, 'seq': -1}),
      ),
      throwsA(isA<PocketRecordingFormatException>()),
    );
    expect(
      () => pocketValidateTraceClockEnvelope({
        'version': 2,
        'idleMs': <double>[],
        'scalars': <Object?>[],
        'workerEvents': <Object>[
          validEvent,
          <String, dynamic>{...validEvent, 'seq': 1},
        ],
      }),
      throwsA(isA<PocketRecordingFormatException>()),
    );
    expect(
      () => PocketRecordingEntry(
        index: 0,
        kind: 'frame',
        result: const <String, dynamic>{
          'traceClock': <String, dynamic>{
            'version': 2,
            'idleMs': <Object?>[],
            'scalars': <Object?>[],
            'workerEvents': <Object?>[],
            'unknown': true,
          },
        },
      ),
      throwsA(isA<PocketRecordingFormatException>()),
    );
  });

  test('shared async quota counts both domains across transactions', () {
    final events = List<Map<String, dynamic>>.generate(
      8192,
      (index) => <String, dynamic>{
        'seq': index,
        'session': 'worker:1',
        'kind': 'turn.begin',
        'data': <String, Object?>{},
      },
      growable: false,
    );
    Map<String, dynamic> traceClock(List<Map<String, dynamic>> lane) => {
      'version': 2,
      'idleMs': <Object?>[],
      'scalars': <Object?>[],
      'workerEvents': lane
          .where((event) => (event['seq'] as int).isEven)
          .toList(),
      'offloadEvents': lane
          .where((event) => (event['seq'] as int).isOdd)
          .map(
            (event) => <String, dynamic>{
              ...event,
              'session': 'offload:1',
              'kind': 'offload.submit',
            },
          )
          .toList(),
    };
    PocketRecordingEntry entry(int index, List<Map<String, dynamic>> lane) =>
        PocketRecordingEntry(
          index: index,
          kind: 'frame',
          result: <String, dynamic>{'traceClock': traceClock(lane)},
        );

    final controller = PocketRecordingController(
      maxEntries: 2,
      maxBytes: 1024 * 1024,
    );
    controller.start(
      PocketRecordingMetadata(width: 10, height: 10, density: 1, tickHz: 60),
    );
    controller.add(entry(0, events));
    final overflow = entry(1, <Map<String, dynamic>>[
      <String, dynamic>{...events.first, 'seq': 8192},
    ]);
    controller.add(overflow);
    expect(controller.isIncomplete, isTrue);
    final recording = controller.finish();
    expect(recording.entries, hasLength(1));
    expect(recording.replayable, isFalse);
    expect(
      () => PocketRecording(
        metadata: recording.metadata,
        entries: <PocketRecordingEntry>[recording.entries.single, overflow],
        maxEntries: 2,
        maxBytes: 1024 * 1024,
        bytes:
            recording.bytes +
            utf8.encode(pocketCanonicalJson(overflow.toJson())).length,
        incomplete: false,
        version: 2,
      ),
      throwsA(isA<PocketRecordingFormatException>()),
    );
  });

  test(
    'worker configuration entries bind the archived QJBC and native grants',
    () {
      final bytecode = Uint8List.fromList([0x50, 0x4a, 0x42, 0x43]);
      final config = <String, dynamic>{
        'protocolVersion': 1,
        'nativeGeneration': 1,
        'bindingGeneration': 12,
        'tickHz': 60,
        'expectedRuntimeAbi': 'quickjs-bytecode-v1:fixture',
        'declaration': <String, dynamic>{
          'entry': 'worker.ts',
          'nodes': <Object?>[],
          'channels': <Object?>[],
        },
        'policy': <String, dynamic>{
          'requiredCapabilities': <String>['runtime.worker'],
          'allowedHttpOrigins': <String>[],
        },
        'limits': <String, dynamic>{
          'heapBytes': 16 * 1024 * 1024,
          'stackBytes': 1024 * 1024,
          'turnBudgetMicros': 10000,
          'windowMicros': 50000,
          'quotaMicros': 10000,
        },
      };
      final args = <String, dynamic>{
        'workerBytecode': <String, dynamic>{
          'key': 'workerBytecode:${pocketSha256(bytecode).substring(0, 16)}',
          'bytes': bytecode.length,
          'sha256': pocketSha256(bytecode),
        },
        'config': config,
        'configSha256': pocketSha256(utf8.encode(pocketCanonicalJson(config))),
      };
      final result = <String, dynamic>{
        'configured': true,
        'traceClock': <String, dynamic>{
          'version': 2,
          'idleMs': <Object?>[],
          'scalars': <Object?>[],
        },
      };
      expect(
        PocketRecordingEntry(
          index: 0,
          kind: 'workerConfigure',
          args: args,
          result: result,
        ).kind,
        'workerConfigure',
      );
      expect(
        () => PocketRecordingEntry(
          index: 0,
          kind: 'workerConfigure',
          args: <String, dynamic>{...args, 'extra': true},
          result: result,
        ),
        throwsA(isA<PocketRecordingFormatException>()),
      );
    },
  );

  test('entry and trace bounds explicitly reject replay', () {
    final controller = PocketRecordingController(maxEntries: 1, maxBytes: 64);
    controller.start(
      PocketRecordingMetadata(width: 10, height: 10, density: 1, tickHz: 60),
    );
    controller.add(
      PocketRecordingEntry(
        index: 0,
        kind: 'send',
        args: <String, dynamic>{'message': List.filled(256, 'x').join()},
        result: const <String, dynamic>{'sent': true},
      ),
    );
    final recording = controller.finish();
    expect(recording.incomplete, isTrue);
    expect(recording.replayable, isFalse);
  });

  test('asset resolver verifies exact SHA-256 and length', () {
    final bytes = Uint8List.fromList(<int>[1, 2, 3]);
    final digest = pocketSha256(bytes);
    final assets = PocketReplayAssets(
      byHash: <String, Uint8List>{digest: bytes},
    );
    expect(assets.resolve(sha256: digest), bytes);
    expect(
      pocketSha256(utf8Bytes('abc')),
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  test('strict parser rejects unknown schema fields and non-finite values', () {
    expect(
      () => PocketRecording.fromJson(<String, dynamic>{'schema': 'wrong'}),
      throwsA(isA<PocketRecordingFormatException>()),
    );
    expect(
      () => pocketCanonicalJson(<String, dynamic>{'value': double.nan}),
      throwsA(isA<PocketRecordingFormatException>()),
    );
  });

  test('entry error snapshots cannot mutate recorded bytes or results', () {
    final error = <String, dynamic>{
      'type': 'RangeError',
      'message': 'original',
    };
    final entry = PocketRecordingEntry(
      index: 0,
      kind: 'send',
      args: const <String, dynamic>{},
      result: const <String, dynamic>{'sent': true},
      error: error,
    );
    final controller = PocketRecordingController(maxEntries: 2, maxBytes: 4096);
    controller.start(
      PocketRecordingMetadata(width: 10, height: 10, density: 1, tickHz: 60),
    );
    controller.add(entry);
    final recordedBytes = controller.recordedBytes;

    error['message'] = List.filled(2048, 'x').join();
    expect(entry.error!['message'], 'original');
    expect(controller.recordedBytes, recordedBytes);
    expect(
      () => entry.error!['message'] = 'mutated',
      throwsA(isA<UnsupportedError>()),
    );
  });
}

Uint8List utf8Bytes(String value) => Uint8List.fromList(value.codeUnits);
