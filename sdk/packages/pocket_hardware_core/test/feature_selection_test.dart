import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pocket_hardware_core/pocket_hardware_core.dart';
import 'package:pocket_services/pocket_services.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  test(
    'feature providers advertise only selected capabilities and permissions',
    () {
      for (final feature in HardwareFeature.values) {
        final plugin = HardwareCapabilityPlugin(
          features: {feature},
          pluginId: 'flutter.${feature.name}',
          includeLegacyPermissions: false,
        );
        expect(
          plugin.descriptor.capabilities.keys.toSet(),
          HardwareFeatures.capabilities(feature),
        );
        expect(
          plugin.descriptor.capabilities,
          isNot(contains(HardwareCapabilities.requestPermission)),
        );
        if (feature != HardwareFeature.camera) {
          expect(
            plugin.descriptor.optionalPermissions,
            isNot(contains(HardwarePermissions.camera)),
          );
        }
        expect(
          plugin.descriptor.optionalPermissions,
          isNot(contains(HardwarePermissions.microphone)),
        );
      }
    },
  );

  test(
    'selected sensor provider uses its native channel and denies unrelated requests',
    () async {
      const channel = MethodChannel('com.pocketnexus.host/hardware/sensors');
      final calls = <MethodCall>[];
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .setMockMethodCallHandler(channel, (call) async {
            calls.add(call);
            return {'ok': true, 'realSensors': true, 'accelX': 0.42};
          });
      final plugin = HardwareCapabilityPlugin(
        features: {HardwareFeature.sensors},
        pluginId: 'flutter.sensors',
        includeLegacyPermissions: false,
      );
      final host = PocketHost(
        registry: PocketHostRegistry(),
        streams: PocketStreamBridge(send: (_, __) => true),
        allowedCapabilities: HardwareCapabilities.all,
        send: (_, __) => true,
      );
      final manager = PocketPluginManager(
        host: host,
        appId: 'test.selection',
        sessionId: 'session',
        allowedPermissions: {HardwarePermissions.sensors},
        onPermissionRequest: (request) => request.requested,
      )..register(plugin);
      try {
        final availability = manager.negotiate(
          required: [HardwareCapabilities.sensorsRead],
          requestedPermissions: {HardwarePermissions.sensors},
        );
        await manager.activate(availability);
        expect(
          (await manager.invoke(HardwareCapabilities.sensorsRead)
              as Map)['accelX'],
          0.42,
        );
        expect(calls.single.method, 'readSensors');
        expect(
          (calls.single.arguments as Map)['sessionId'],
          endsWith(':flutter.sensors'),
        );
        await expectLater(
          manager.invoke(HardwareCapabilities.cameraPreviewStart),
          throwsA(isA<PocketCapabilityException>()),
        );
        await manager.dispose();
        expect(calls.last.method, 'disposeSession');
      } finally {
        await manager.dispose();
        host.dispose();
        TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
            .setMockMethodCallHandler(channel, null);
      }
    },
  );

  test(
    'stream stop routes by retained kind without another stream ownership map',
    () async {
      final calls = <String>[];
      final messenger =
          TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
      const sensors = MethodChannel('com.pocketnexus.host/hardware/sensors');
      const bluetooth = MethodChannel(
        'com.pocketnexus.host/hardware/bluetooth',
      );
      messenger.setMockMethodCallHandler(sensors, (call) async {
        calls.add('sensors:${call.method}');
        return {'ok': true};
      });
      messenger.setMockMethodCallHandler(bluetooth, (call) async {
        calls.add('bluetooth:${call.method}');
        return {'ok': true};
      });
      try {
        // The public default adapter also follows the split native channels.
        await MethodChannelHardwarePlatform().invoke('readSensors');
        final platform =
            createHardwarePlatform({
                  HardwareFeature.sensors,
                  HardwareFeature.bluetooth,
                })
                as HardwareStreamingPlatform;
        await platform.startHardwareStream({
          'kind': 'sensors',
          'streamId': 's',
        });
        await platform.stopHardwareStream({'kind': 'sensors', 'streamId': 's'});
        await platform.startHardwareStream({
          'kind': 'ble.notifications',
          'streamId': 'b',
        });
        await platform.stopHardwareStream({
          'kind': 'ble.notifications',
          'streamId': 'b',
        });
        expect(
          () => platform.stopHardwareStream({'streamId': 's'}),
          throwsA(isA<HardwarePlatformException>()),
        );
        expect(calls, [
          'sensors:readSensors',
          'sensors:startHardwareStream',
          'sensors:stopHardwareStream',
          'bluetooth:startHardwareStream',
          'bluetooth:stopHardwareStream',
        ]);
      } finally {
        messenger.setMockMethodCallHandler(sensors, null);
        messenger.setMockMethodCallHandler(bluetooth, null);
      }
    },
  );

  test(
    'independent location and biometrics providers retain trusted session ownership',
    () async {
      final platform = _SessionRecordingPlatform();
      final location = HardwareCapabilityPlugin(
        platform: platform,
        features: {HardwareFeature.location},
        pluginId: 'flutter.location',
        includeLegacyPermissions: false,
      );
      final biometrics = HardwareCapabilityPlugin(
        platform: platform,
        features: {HardwareFeature.biometrics},
        pluginId: 'flutter.biometrics',
        includeLegacyPermissions: false,
      );
      final host = PocketHost(
        registry: PocketHostRegistry(),
        streams: PocketStreamBridge(send: (_, __) => true),
        allowedCapabilities: HardwareCapabilities.all,
        send: (_, __) => true,
      );
      final manager =
          PocketPluginManager(
              host: host,
              appId: 'test.permissions',
              sessionId: 'session.permissions',
              allowedPermissions: {
                HardwarePermissions.location,
                HardwarePermissions.biometrics,
              },
              onPermissionRequest: (request) => request.requested,
            )
            ..register(location)
            ..register(biometrics);
      const locationSession =
          'test.permissions:session.permissions:flutter.location';
      const biometricsSession =
          'test.permissions:session.permissions:flutter.biometrics';
      try {
        final availability = manager.negotiate(
          required: [
            HardwareCapabilities.locationCurrent,
            HardwareCapabilities.biometricAuthenticate,
          ],
          requestedPermissions: {
            HardwarePermissions.location,
            HardwarePermissions.biometrics,
          },
        );
        await manager.activate(availability);

        await manager.invoke(HardwareCapabilities.locationCurrent);
        await manager.invoke(HardwareCapabilities.biometricAuthenticate, {
          'reason': 'Unlock secure notes',
        });

        final locationCall = platform.calls.singleWhere(
          (call) => call.method == 'getCurrentLocation',
        );
        expect(locationCall.arguments['sessionId'], locationSession);
        final biometricCall = platform.calls.singleWhere(
          (call) => call.method == 'authenticateBiometrics',
        );
        expect(biometricCall.arguments['sessionId'], biometricsSession);
        expect(biometricCall.arguments['reason'], 'Unlock secure notes');

        await manager.deactivate();
        final firstTeardown = platform.calls
            .where((call) => call.method == 'disposeSession')
            .toList();
        expect(firstTeardown, hasLength(2));
        expect(
          firstTeardown.map((call) => call.arguments['sessionId']).toSet(),
          {locationSession, biometricsSession},
        );

        await manager.activate(availability);
        await manager.dispose();
        final allTeardown = platform.calls
            .where((call) => call.method == 'disposeSession')
            .toList();
        expect(allTeardown, hasLength(4));
        expect(allTeardown.map((call) => call.arguments['sessionId']).toSet(), {
          locationSession,
          biometricsSession,
        });
      } finally {
        await manager.dispose();
        host.dispose();
      }
    },
  );

  test(
    'weather without a selected location provider cannot silently access native location',
    () async {
      final platform = createHardwarePlatform({HardwareFeature.weather});
      await expectLater(
        platform.invoke('getCurrentLocation'),
        throwsA(isA<HardwarePlatformException>()),
      );
    },
  );

  test(
    'weather-only requires explicit coordinates without probing native location',
    () async {
      final platform = _RecordingPlatform();
      final plugin = HardwareCapabilityPlugin(
        platform: platform,
        weatherFetcher: (_) async => <String, dynamic>{
          'current': <String, dynamic>{'temperature_2m': 20.0},
        },
        features: {HardwareFeature.weather},
        pluginId: 'dart.weather',
        includeLegacyPermissions: false,
      );
      expect(plugin.descriptor.optionalPermissions, {
        HardwarePermissions.network,
      });
      expect(
        plugin
            .descriptor
            .capabilities[HardwareCapabilities.weatherCurrent]!
            .optionalPermissions,
        isEmpty,
      );
      final host = PocketHost(
        registry: PocketHostRegistry(),
        streams: PocketStreamBridge(send: (_, __) => true),
        allowedCapabilities: HardwareCapabilities.all,
        send: (_, __) => true,
      );
      final manager = PocketPluginManager(
        host: host,
        appId: 'test.weather',
        sessionId: 'session',
        allowedPermissions: {HardwarePermissions.network},
        onPermissionRequest: (request) => request.requested,
      )..register(plugin);
      try {
        final availability = manager.negotiate(
          required: [HardwareCapabilities.weatherCurrent],
          requestedPermissions: {HardwarePermissions.network},
        );
        await manager.activate(availability);
        final explicit =
            await manager.invoke(HardwareCapabilities.weatherCurrent, {
                  'latitude': 1.29,
                  'longitude': 103.85,
                })
                as Map;
        expect(explicit['ok'], isTrue);
        expect(explicit['realGps'], isFalse);
        expect(platform.calls, isEmpty);
        await expectLater(
          manager.invoke(HardwareCapabilities.weatherCurrent),
          throwsA(
            isA<PocketCapabilityException>()
                .having((error) => error.code, 'code', 'invalid_argument')
                .having(
                  (error) => error.message,
                  'message',
                  contains('latitude and longitude'),
                ),
          ),
        );
        expect(platform.calls, isEmpty);
      } finally {
        await manager.dispose();
        host.dispose();
      }
    },
  );
}

final class _RecordingPlatform implements HardwarePlatform {
  final calls = <String>[];

  @override
  Future<Map<String, dynamic>> invoke(
    String method, [
    Map<String, dynamic> arguments = const <String, dynamic>{},
  ]) async {
    calls.add(method);
    return <String, dynamic>{
      'ok': false,
      'errorCode': 'hardware_unexpected',
      'error': 'native location should not be called',
    };
  }
}

final class _SessionRecordingPlatform implements HardwarePlatform {
  final calls = <_SessionCall>[];

  @override
  Future<Map<String, dynamic>> invoke(
    String method, [
    Map<String, dynamic> arguments = const <String, dynamic>{},
  ]) async {
    calls.add(_SessionCall(method, Map<String, dynamic>.from(arguments)));
    if (method == 'getCurrentLocation') {
      return <String, dynamic>{
        'ok': true,
        'latitude': 1.29,
        'longitude': 103.85,
        'realGps': true,
      };
    }
    return <String, dynamic>{'ok': true};
  }
}

final class _SessionCall {
  _SessionCall(this.method, this.arguments);

  final String method;
  final Map<String, dynamic> arguments;
}
