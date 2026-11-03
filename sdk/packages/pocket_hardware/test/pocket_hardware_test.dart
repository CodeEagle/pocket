import 'package:flutter_test/flutter_test.dart';
import 'package:pocket_hardware/pocket_hardware.dart';
import 'package:pocket_services/pocket_services.dart';

final class _RecordingHardwarePlatform implements HardwarePlatform {
  _RecordingHardwarePlatform(this.responses);

  final Map<String, Map<String, dynamic>> responses;
  final List<String> calls = <String>[];

  @override
  Future<Map<String, dynamic>> invoke(
    String method, [
    Map<String, dynamic> arguments = const <String, dynamic>{},
  ]) async {
    calls.add(method);
    return responses[method] ??
        <String, dynamic>{
          'ok': false,
          'errorCode': 'hardware_unsupported',
          'error': '$method is unavailable',
        };
  }
}

void main() {
  test('HardwarePlugin dispatches BLE scan, sensor permission, and numeric sensor read before disposeSession', () async {
    final platform = _RecordingHardwarePlatform(<String, Map<String, dynamic>>{
      'startBleScan': <String, dynamic>{
        'ok': true,
        'realBle': true,
        'state': 'poweredOn',
        'devices': const <Map<String, dynamic>>[],
      },
      'requestPermission': <String, dynamic>{
        'ok': true,
        'permission': 'sensors',
        'granted': true,
        'status': 'granted',
        'realHardware': true,
      },
      'readSensors': <String, dynamic>{
        'ok': true,
        'realSensors': true,
        'accelX': 0.12,
        'accelY': -0.04,
        'accelZ': 0.08,
        'gravityX': 0.0,
        'gravityY': -0.98,
        'gravityZ': -0.15,
        'gyroX': 0.01,
        'gyroY': 0.02,
        'gyroZ': -0.01,
        'pitch': 0.15,
        'roll': 0.02,
        'yaw': 0.31,
      },
      'disposeSession': <String, dynamic>{'ok': true, 'disposed': true},
    });
    final sent = <Map<String, dynamic>>[];
    final registry = PocketHostRegistry();
    final host = PocketHost(
      registry: registry,
      streams: PocketStreamBridge(send: (_, __) => true),
      allowedCapabilities: HardwareCapabilities.all,
      send: (method, params) {
        sent.add(<String, dynamic>{'method': method, ...params});
        return true;
      },
    );
    final plugin = HardwarePlugin(platform: platform);
    final manager = PocketPluginManager(
      host: host,
      appId: 'test.pocket_hardware',
      sessionId: 'session-1',
      allowedPermissions: HardwarePermissions.all,
      onPermissionRequest: (_) => HardwarePermissions.all,
    );
    manager.register(plugin);
    final availability = manager.negotiate(
      required: const <String>[],
      optional: HardwareCapabilities.all,
      requestedPermissions: HardwarePermissions.all,
    );
    await manager.activate(availability);

    final bleResult = await manager.invoke(
      HardwareCapabilities.bluetoothScan,
      const <String, dynamic>{'timeoutMs': 1600},
    ) as Map<String, dynamic>;
    expect(bleResult['ok'], isTrue);
    final permResult = await manager.invoke(
      HardwareCapabilities.requestPermission,
      const <String, dynamic>{'permission': HardwarePermissions.sensors},
    ) as Map<String, dynamic>;
    expect(permResult['ok'], isTrue);
    expect(permResult['granted'], isTrue);
    final sensorResult = await manager.invoke(
      HardwareCapabilities.sensorsRead,
    ) as Map<String, dynamic>;
    expect(sensorResult['ok'], isTrue);
    expect(sensorResult['accelX'], 0.12);

    await manager.dispose();
    host.dispose();
    expect(
      platform.calls,
      containsAllInOrder(<String>[
        'startBleScan',
        'requestPermission',
        'readSensors',
        'disposeSession',
      ]),
    );
  });
}
