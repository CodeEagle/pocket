import 'package:flutter/services.dart';
import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:pocket_host/main.dart';

import 'guest_interaction_test.dart' as guest;

/// Device/simulator integration coverage for the compiled hardware provider on
/// iOS or Android. This test intentionally talks to the production
/// MethodChannel; it does not install a fake platform handler and does not turn
/// unsupported simulator hardware into a passing fixture.
void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  testWidgets(
    'native hardware provider reports real availability and cleanup',
    (tester) async {
      const channel = MethodChannel('com.pocketnexus.host/hardware');
      await tester.pumpWidget(const PocketHostApp());
      await guest.waitFor(tester, '00');

      final permissions = await _map(channel, 'checkPermissions');
      expect(permissions['ok'], isTrue);
      final permissionMap = _object(permissions['permissions']);
      for (final name in <String>[
        'camera',
        'photos',
        'bluetooth',
        'sensors',
        'biometrics',
        'location',
      ]) {
        final status = _object(permissionMap[name]);
        expect(status['supported'], isA<bool>(), reason: '$name supported');
        expect(status['status'], isA<String>(), reason: '$name status');
        expect(status['granted'], isA<bool>(), reason: '$name granted');
      }

      // Do not request camera permission in an automated run. On a simulator,
      // or on a device where the user has not granted it, a camera request must
      // be a structured failure and must not fabricate a texture.
      final cameraStatus = _object(permissionMap['camera']);
      final camera = await _map(
        channel,
        'startCameraPreview',
        <String, dynamic>{'lens': 'back'},
      );
      if (cameraStatus['supported'] != true ||
          cameraStatus['granted'] != true) {
        expect(camera['ok'], isFalse);
        expect(camera['errorCode'], isA<String>());
        expect(camera['textureId'], isNull);
      } else {
        // A previously-authorized physical device may legitimately start a real
        // camera.  Even there, admission requires the complete texture shape;
        // no synthetic texture is accepted.
        expect(camera['ok'], isTrue);
        expect(camera['textureId'], isA<num>());
        expect(camera['width'], isA<num>());
        expect(camera['height'], isA<num>());
        final stopped = await _map(channel, 'stopCameraPreview');
        expect(stopped['ok'], isTrue);
      }

      final sensorStatus = _object(permissionMap['sensors']);
      final sensors = await _map(channel, 'readSensors');
      if (sensorStatus['supported'] != true) {
        expect(sensors['ok'], isFalse);
        expect(sensors['errorCode'], isA<String>());
        expect(sensors['realSensors'], isNot(true));
      } else if (sensors['ok'] == true) {
        expect(sensors['realSensors'], isTrue);
      } else {
        // A device can lose sensor availability between the snapshot and read;
        // that transition must still be explicit rather than a zero fixture.
        expect(sensors['errorCode'], isA<String>());
        expect(sensors['realSensors'], isNot(true));
      }

      // The host calls this during plugin deactivation.  Calling it directly
      // twice proves that cutover cleanup is idempotent and that the provider
      // remains queryable for the next guest/session.
      final disposed = await _map(channel, 'disposeSession');
      expect(disposed['ok'], isTrue);
      expect((await _map(channel, 'disposeSession'))['ok'], isTrue);
      final afterDispose = await _map(channel, 'checkPermissions');
      expect(afterDispose['ok'], isTrue);
      expect(_object(afterDispose['permissions']).keys, contains('camera'));

      await tester.pumpWidget(const SizedBox.shrink());
      await tester.pump();
    },
  );
}

Future<Map<String, dynamic>> _map(
  MethodChannel channel,
  String method, [
  Map<String, dynamic> arguments = const <String, dynamic>{},
]) async {
  final value = await channel.invokeMethod<Object?>(method, arguments);
  expect(value, isA<Map>(), reason: '$method must return a structured map');
  return Map<String, dynamic>.from(value! as Map);
}

Map<String, dynamic> _object(Object? value) {
  expect(value, isA<Map>());
  return Map<String, dynamic>.from(value! as Map);
}
