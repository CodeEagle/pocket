import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:pocket_flutter/src/pocket_worker_runtime.dart';

void main() {
  test('worker native config carries QJBC, grants, declaration and limits', () {
    final program = PocketWorkerProgram(
      bytecode: Uint8List.fromList([0x50, 0x4a, 0x42, 0x43]),
      declaration: {
        'entry': 'worker.ts',
        'nodes': [
          {'name': 'http', 'kind': 'http'},
        ],
        'channels': [
          {
            'name': 'telemetry',
            'kind': 'ring',
            'direction': 'worker-to-ui',
            'recordBytes': 128,
            'capacity': 4,
          },
        ],
      },
      expectedRuntimeAbi: 'quickjs-bytecode-v1:fixture',
      bindingGeneration: 7,
      tickHz: 60,
      requiredCapabilities: const ['net.http'],
    );

    final config = jsonDecode(program.nativeConfigJson(nativeGeneration: 12))
        as Map<String, dynamic>;
    expect(config['protocolVersion'], 1);
    expect(config['nativeGeneration'], 12);
    expect(config['bindingGeneration'], 7);
    expect(config['tickHz'], 60);
    expect(config['policy']['requiredCapabilities'], ['net.http']);
    expect(config['policy']['allowedHttpOrigins'], isEmpty);
    expect(config['declaration']['channels'], hasLength(1));
    expect(config['limits']['turnBudgetMicros'], 10000);

    final copy = program.bytecode;
    copy[0] = 0;
    expect(program.bytecode.first, 0x50);
  });

  test('worker policy defaults to no network grants', () {
    final program = PocketWorkerProgram(
      bytecode: Uint8List.fromList([1]),
      declaration: const {'entry': 'worker.ts', 'nodes': [], 'channels': []},
      expectedRuntimeAbi: 'quickjs-bytecode-v1:fixture',
      bindingGeneration: 1,
      tickHz: 60,
      requiredCapabilities: const [],
    );
    final config = jsonDecode(program.nativeConfigJson(nativeGeneration: 1))
        as Map<String, dynamic>;
    expect(config['policy']['allowedHttpOrigins'], isEmpty);
  });

  test('worker limits reject CPU quotas beyond their window', () {
    expect(
      () => const PocketWorkerLimits(
        windowMicros: 100,
        quotaMicros: 101,
      ).validate(),
      throwsFormatException,
    );
  });
}
