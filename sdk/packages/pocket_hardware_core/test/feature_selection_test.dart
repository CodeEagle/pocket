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
    'weather without a selected location provider cannot silently access native location',
    () async {
      final platform = createHardwarePlatform({HardwareFeature.weather});
      await expectLater(
        platform.invoke('getCurrentLocation'),
        throwsA(isA<HardwarePlatformException>()),
      );
    },
  );
}
