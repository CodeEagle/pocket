import 'dart:convert';
import 'dart:io';

import 'package:crypto/crypto.dart' as crypto;
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pocket_sdk/pocket_sdk.dart';

const _fixtureAssetNames = <String>[
  'app.bytecode.json',
  'guest-manifest.json',
  'app.worker.qjbc',
];

String? _fixtureAssetsPath() {
  final root = Platform.environment['POCKET_RECORDING_WORKER_FIXTURE_DIR'];
  if (root == null || root.trim().isEmpty) return null;
  return '$root/assets';
}

String? _fixtureSkipReason(String? assetsPath) {
  if (assetsPath == null) {
    return 'Set POCKET_RECORDING_WORKER_FIXTURE_DIR to a generated '
        'buildGuest Worker fixture root.';
  }
  final missing = _fixtureAssetNames
      .where((name) => !File('$assetsPath/$name').existsSync())
      .toList(growable: false);
  if (missing.isEmpty) return null;
  return 'Missing buildGuest Worker fixture at $assetsPath: '
      '${missing.join(', ')}';
}

void main() {
  final binding = TestWidgetsFlutterBinding.ensureInitialized();
  final fixtureAssetsPath = _fixtureAssetsPath();
  final fixtureSkip = _fixtureSkipReason(fixtureAssetsPath);
  late Directory directory;

  setUp(() async {
    directory = await Directory.systemTemp.createTemp(
      'pocket-recording-worker-session-',
    );
    binding.defaultBinaryMessenger.setMockMethodCallHandler(
      const MethodChannel('plugins.flutter.io/path_provider'),
      (_) async => directory.path,
    );
    binding.defaultBinaryMessenger.setMockMessageHandler('flutter/assets', (
      data,
    ) async {
      if (data == null) return null;
      final assetName = utf8.decode(data.buffer.asUint8List());
      if (!assetName.startsWith('assets/')) return null;
      final relative = assetName.substring('assets/'.length);
      if (!_fixtureAssetNames.contains(relative)) return null;
      final assetsPath = fixtureAssetsPath;
      if (assetsPath == null) return null;
      final bytes = await File('$assetsPath/$relative').readAsBytes();
      return ByteData.sublistView(bytes);
    });
  });

  tearDown(() async {
    binding.defaultBinaryMessenger.setMockMethodCallHandler(
      const MethodChannel('plugins.flutter.io/path_provider'),
      null,
    );
    binding.defaultBinaryMessenger.setMockMessageHandler(
      'flutter/assets',
      null,
    );
    rootBundle.clear();
    if (await directory.exists()) await directory.delete(recursive: true);
  });

  test(
    'recording attach admits the real buildGuest Worker artifact',
    () async {
      final assetsPath = fixtureAssetsPath;
      if (assetsPath == null) {
        fail('Fixture path unexpectedly unavailable after skip evaluation');
      }
      final metadata = Map<String, dynamic>.from(
        jsonDecode(await File('$assetsPath/app.bytecode.json').readAsString())
            as Map,
      );
      final manifest = Map<String, dynamic>.from(
        jsonDecode(await File('$assetsPath/guest-manifest.json').readAsString())
            as Map,
      );
      final workerDescriptor = Map<String, dynamic>.from(
        metadata['worker'] as Map,
      );
      final bytecodeDescriptor = Map<String, dynamic>.from(
        workerDescriptor['bytecode'] as Map,
      );
      final expectedDeclaration = Map<String, Object?>.from(
        workerDescriptor['declaration'] as Map,
      );
      final expectedWorkerCapabilities =
          (workerDescriptor['requiredCaps'] as List).cast<String>();
      final expectedManifestCapabilities =
          ((manifest['capabilities'] as Map)['requires'] as List)
              .cast<String>();
      final workerBytes = await File(
        '$assetsPath/app.worker.qjbc',
      ).readAsBytes();
      const allowedOrigin = 'https://worker-recording.example';

      final library = PocketRecordingLibrary()..start();
      final config = library.attach(
        const PocketAppConfig(
          appId: 'worker.recording.session',
          bytecodeAsset: 'assets/app.qjbc',
          pakAsset: 'assets/app.pak',
          metadataAsset: 'assets/app.bytecode.json',
          manifestAsset: 'assets/guest-manifest.json',
          workerHttpOrigins: {allowedOrigin},
        ),
      );
      final session = PocketSession(config: config);
      try {
        await session.initialize();

        expect(session.ready, isTrue);
        expect(session.lastError, isNull);
        expect(session.workerProgram, isNotNull);

        final program = session.workerProgram!;
        expect(program.bytecode, orderedEquals(workerBytes));
        expect(
          crypto.sha256.convert(program.bytecode).toString(),
          bytecodeDescriptor['sha256'],
        );
        expect(
          program.requiredCapabilities.toSet(),
          expectedWorkerCapabilities.toSet(),
        );
        expect(
          program.requiredCapabilities.toSet(),
          expectedManifestCapabilities.toSet(),
        );
        expect(program.allowedHttpOrigins, [allowedOrigin]);
        expect(program.expectedRuntimeAbi, metadata['runtimeAbi']);
        expect(
          program.bindingGeneration,
          (metadata['bindingGeneration'] as num).toInt(),
        );
        expect(program.tickHz, (metadata['tickHz'] as num).toInt());
        expect(program.declaration, expectedDeclaration);

        final nativeConfig =
            jsonDecode(program.nativeConfigJson(nativeGeneration: 1))
                as Map<String, dynamic>;
        expect(nativeConfig['declaration'], expectedDeclaration);
        expect(nativeConfig['policy'], {
          'requiredCapabilities': program.requiredCapabilities,
          'allowedHttpOrigins': [allowedOrigin],
        });

        expect(config.recordingFactory, isNotNull);
        final recorder = config.recordingFactory!.call();
        expect(recorder.enabled, isTrue);
        expect(library.status()['runtimes'], hasLength(1));
      } finally {
        await session.close();
        library.stop();
      }
    },
    skip: fixtureSkip,
  );
}
