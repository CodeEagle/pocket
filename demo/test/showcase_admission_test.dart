import 'dart:convert';
import 'dart:io';

import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pocket_host/main.dart' as showcase;
import 'package:pocket_sdk/pocket_sdk.dart';

/// Admission smoke test for the real showcase host.
///
/// This deliberately uses the demo's public config, real rootBundle assets and
/// real hardware plugin factory.  Only path_provider is mocked: the session's
/// performance history needs a writable application-support directory, while
/// no hardware or package-info method is expected during admission/activation.
void main() {
  final binding = TestWidgetsFlutterBinding.ensureInitialized();
  late Directory supportDirectory;

  setUp(() async {
    supportDirectory = await Directory.systemTemp.createTemp(
      'pocket-showcase-admission-',
    );
    binding.defaultBinaryMessenger.setMockMethodCallHandler(
      const MethodChannel('plugins.flutter.io/path_provider'),
      (call) async => supportDirectory.path,
    );
  });

  tearDown(() async {
    binding.defaultBinaryMessenger.setMockMethodCallHandler(
      const MethodChannel('plugins.flutter.io/path_provider'),
      null,
    );
    if (await supportDirectory.exists()) {
      await supportDirectory.delete(recursive: true);
    }
  });

  test('showcase assets and real plugins pass session admission', () async {
    // Read the production bundle directly so this test cannot pass with a
    // synthetic flutter/assets handler or a hand-written manifest substitute.
    final metadata =
        (jsonDecode(
                  await rootBundle.loadString(
                    showcase.showcaseConfig.metadataAsset,
                  ),
                )
                as Map)
            .cast<String, dynamic>();
    final manifest =
        (jsonDecode(
                  await rootBundle.loadString(
                    showcase.showcaseConfig.manifestAsset,
                  ),
                )
                as Map)
            .cast<String, dynamic>();
    expect(metadata['version'], '0.1.0');
    expect(metadata['build'], greaterThanOrEqualTo(1));
    expect(
      (manifest['capabilities'] as Map)['requires'],
      contains('text.glyphs.baked'),
    );

    final session = PocketSession(config: showcase.showcaseConfig);
    try {
      await session.initialize();

      expect(session.ready, isTrue);
      expect(session.failure, isNull);
      expect(session.stage, 'loading');
      expect(session.runtimeInfo()['appId'], 'pocket.host.demo');
      expect(session.runtimeInfo()['source'], 'embedded');
      expect(session.runtimeInfo()['build'], metadata['build']);
    } finally {
      await session.close();
    }
  });
}
