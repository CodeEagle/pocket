import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pocket_sdk/pocket_sdk.dart';
import 'package:pocket_services/pocket_services.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  const channel = MethodChannel('dev.pocketjs/pocket_archive');

  tearDown(() {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(channel, null);
  });

  test(
    'maps MissingPluginException to native-archive-unavailable at SDK boundary',
    () async {
      await expectLater(
        PocketSession.extractNativeArchive(
          archivePath: '/tmp/bundle.7z',
          destinationPath: '/tmp/out',
          maxOutputBytes: 1024,
        ),
        throwsA(
          isA<PocketPackageException>().having(
            (error) => error.code,
            'code',
            'native-archive-unavailable',
          ),
        ),
      );
    },
  );

  test(
    'maps PlatformException to deterministic bundle-format at SDK boundary',
    () async {
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .setMockMethodCallHandler(channel, (MethodCall call) async {
            throw PlatformException(
              code: 'archive_extract',
              message: 'corrupt 7z header',
            );
          });

      await expectLater(
        PocketSession.extractNativeArchive(
          archivePath: '/tmp/bundle.7z',
          destinationPath: '/tmp/out',
          maxOutputBytes: 1024,
        ),
        throwsA(
          isA<PocketPackageException>()
              .having((error) => error.code, 'code', 'bundle-format')
              .having(
                (error) => error.message,
                'message',
                contains('corrupt 7z header'),
              ),
        ),
      );
    },
  );
}
