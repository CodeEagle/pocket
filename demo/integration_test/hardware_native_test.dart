import 'package:flutter/services.dart';
import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:pocket_host/main.dart';
import 'package:pocket_permissions/pocket_permissions.dart';

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
      const cameraChannel = MethodChannel(
        'com.pocketnexus.host/hardware/camera',
      );
      const bluetoothChannel = MethodChannel(
        'com.pocketnexus.host/hardware/bluetooth',
      );
      const sensorsChannel = MethodChannel(
        'com.pocketnexus.host/hardware/sensors',
      );
      const locationChannel = MethodChannel(
        'com.pocketnexus.host/hardware/location',
      );
      const biometricsChannel = MethodChannel(
        'com.pocketnexus.host/hardware/biometrics',
      );
      await tester.pumpWidget(pocketHostApp());
      await guest.waitFor(tester, '00');

      // This is the same service registered by PocketPermissionsPlugin. It
      // delegates to permission_handler's real platform interface and does not
      // request anything during this smoke test.
      final permissions = PocketSystemPermissions();
      final cameraStatus = await permissions.status(
        PocketPermissionNames.hardwareCamera,
      );
      final photosStatus = await permissions.status(
        PocketPermissionNames.hardwarePhotos,
      );
      final bluetoothStatus = await permissions.status(
        PocketPermissionNames.hardwareBluetooth,
      );
      final sensorsStatus = await permissions.status(
        PocketPermissionNames.hardwareSensors,
      );
      final locationStatus = await permissions.status(
        PocketPermissionNames.hardwareLocation,
      );
      for (final entry in <MapEntry<String, Map<String, dynamic>>>[
        MapEntry('camera', cameraStatus),
        MapEntry('photos', photosStatus),
        MapEntry('bluetooth', bluetoothStatus),
        MapEntry('sensors', sensorsStatus),
        MapEntry('location', locationStatus),
      ]) {
        expect(entry.value['ok'], isTrue, reason: '${entry.key} status');
        expect(entry.value['status'], isA<String>(), reason: entry.key);
        expect(entry.value['granted'], isA<bool>(), reason: entry.key);
        expect(entry.value['realHardware'], isTrue, reason: entry.key);
      }

      // Do not request camera permission in an automated run. On a simulator,
      // or on a device where the user has not granted it, a camera request must
      // be a structured failure and must not fabricate a texture.
      final camera = await _map(
        cameraChannel,
        'startCameraPreview',
        <String, dynamic>{'lens': 'back'},
      );
      if (camera['ok'] == true) {
        // A previously-authorized physical device may legitimately start a real
        // camera.  Even there, admission requires the complete texture shape;
        // no synthetic texture is accepted.
        expect(camera['textureId'], isA<num>());
        expect(camera['width'], isA<num>());
        expect(camera['height'], isA<num>());
        expect(camera['realHardwareCamera'], isTrue);
        final stopped = await _map(cameraChannel, 'stopCameraPreview');
        expect(stopped['ok'], isTrue);
      } else {
        _expectHardwareFailure(camera, 'camera');
      }

      final sensors = await _map(
        sensorsChannel,
        'readSensors',
        <String, dynamic>{
          'sessionId': 'integration.hardware.session',
          'ownerToken': 'integration.hardware.owner',
          'operationId': 1,
          'timeoutMs': 750,
        },
      );
      if (sensors['ok'] == true) {
        expect(sensors['realSensors'], isTrue);
      } else {
        // A device can lose sensor availability between the snapshot and read;
        // that transition must still be explicit rather than a zero fixture.
        _expectHardwareFailure(sensors, 'sensors');
      }

      final bluetooth = await _map(
        bluetoothChannel,
        'startBleScan',
        <String, dynamic>{
          'timeoutMs': 250,
          'sessionId': 'integration.hardware.session',
        },
      );
      if (bluetooth['ok'] == true) {
        expect(bluetooth['realBle'], isTrue);
        expect(bluetooth['devices'], isA<List>());
      } else {
        _expectHardwareFailure(bluetooth, 'bluetooth');
      }

      // Location is intentionally probed only when access is not already
      // granted. A granted physical device would otherwise wait up to the
      // provider's real location-fix deadline, and this test must never prompt
      // or turn a missing fix into a success fixture.
      if (locationStatus['granted'] != true) {
        final location = await _map(locationChannel, 'getCurrentLocation');
        _expectHardwareFailure(location, 'location');
      }

      // The host calls this during plugin deactivation.  Calling it directly
      // twice on every selected native provider proves that cutover cleanup is
      // idempotent without relying on the deleted aggregate channel.
      for (final channel in <MethodChannel>[
        cameraChannel,
        bluetoothChannel,
        sensorsChannel,
        locationChannel,
        biometricsChannel,
      ]) {
        expect((await _map(channel, 'disposeSession'))['ok'], isTrue);
        expect((await _map(channel, 'disposeSession'))['ok'], isTrue);
      }

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

void _expectHardwareFailure(Map<String, dynamic> value, String feature) {
  expect(value['ok'], isFalse, reason: '$feature must not fabricate success');
  expect(value['errorCode'], isA<String>(), reason: '$feature error code');
  expect(value['realHardware'], isNot(true), reason: '$feature realHardware');
}
