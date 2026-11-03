import 'dart:convert';
import 'dart:typed_data';

import 'package:crypto/crypto.dart';
import 'package:pocket_sdk/src/pocket_worker.dart';
import 'package:test/test.dart';

void main() {
  final qjbc = Uint8List.fromList([
    0x50, 0x4a, 0x42, 0x43, // PJBC
    0x01, 0x00,
  ]);

  String metadataFor(Uint8List bytes, {String path = 'app.worker.qjbc'}) =>
      jsonEncode({
        'worker': {
          'kind': 'quickjs-bytecode',
          'protocolVersion': 1,
          'bytecode': {
            'path': path,
            'bytes': bytes.length,
            'sha256': sha256.convert(bytes).toString(),
          },
          'declaration': {
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
          'requiredCaps': ['net.http', 'runtime.worker'],
          'runtimeAbi': 'quickjs-bytecode-v1:fixture',
          'bindingGeneration': 7,
          'tickHz': 60,
        },
      });

  test('verifies QJBC size, hash, ABI, declaration and trusted grants', () {
    final artifact = PocketWorkerArtifact.verify(
      appMetadataJson: metadataFor(qjbc),
      bytecode: qjbc,
      actualRuntimeAbi: 'quickjs-bytecode-v1:fixture',
      expectedBindingGeneration: 7,
      expectedTickHz: 60,
      admittedCapabilities: const {'net.http', 'runtime.worker'},
      allowedHttpOrigins: const ['https://api.example'],
    );

    expect(artifact.bytecodePath, 'app.worker.qjbc');
    expect(artifact.program.bytecode, qjbc);
    expect(artifact.program.requiredCapabilities, ['net.http', 'runtime.worker']);
    expect(artifact.program.allowedHttpOrigins, ['https://api.example']);
    final config = jsonDecode(
      artifact.program.nativeConfigJson(nativeGeneration: 8),
    ) as Map<String, dynamic>;
    expect(config['policy']['allowedHttpOrigins'], ['https://api.example']);
    expect(config['declaration']['channels'], hasLength(1));
  });

  test('network stays denied when the host supplies no origin grants', () {
    final artifact = PocketWorkerArtifact.verify(
      appMetadataJson: metadataFor(qjbc),
      bytecode: qjbc,
      actualRuntimeAbi: 'quickjs-bytecode-v1:fixture',
      expectedBindingGeneration: 7,
      expectedTickHz: 60,
      admittedCapabilities: const {'net.http', 'runtime.worker'},
    );
    expect(artifact.program.allowedHttpOrigins, isEmpty);
  });

  test('rejects modified bytes, ungranted caps, ABI drift and unsafe paths', () {
    expect(
      () => PocketWorkerArtifact.verify(
        appMetadataJson: metadataFor(qjbc),
        bytecode: Uint8List.fromList([...qjbc, 0]),
        actualRuntimeAbi: 'quickjs-bytecode-v1:fixture',
        expectedBindingGeneration: 7,
        expectedTickHz: 60,
        admittedCapabilities: const {'net.http', 'runtime.worker'},
      ),
      throwsFormatException,
    );
    expect(
      () => PocketWorkerArtifact.verify(
        appMetadataJson: metadataFor(qjbc),
        bytecode: qjbc,
        actualRuntimeAbi: 'quickjs-bytecode-v1:fixture',
        expectedBindingGeneration: 7,
        expectedTickHz: 60,
        admittedCapabilities: const {},
      ),
      throwsFormatException,
    );
    expect(
      () => PocketWorkerArtifact.verify(
        appMetadataJson: metadataFor(qjbc),
        bytecode: qjbc,
        actualRuntimeAbi: 'different-abi',
        expectedBindingGeneration: 7,
        expectedTickHz: 60,
        admittedCapabilities: const {'net.http', 'runtime.worker'},
      ),
      throwsFormatException,
    );
    expect(
      () => PocketWorkerArtifact.verify(
        appMetadataJson: metadataFor(qjbc, path: '../escape.qjbc'),
        bytecode: qjbc,
        actualRuntimeAbi: 'quickjs-bytecode-v1:fixture',
        expectedBindingGeneration: 7,
        expectedTickHz: 60,
        admittedCapabilities: const {'net.http', 'runtime.worker'},
      ),
      throwsFormatException,
    );
  });
}
