import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:pocket_hardware/pocket_hardware.dart';
import 'package:pocket_services/pocket_services.dart';

final class _RecordingHardwarePlatform implements HardwarePlatform {
  _RecordingHardwarePlatform(this.responses);

  final Map<String, Map<String, dynamic>> responses;
  final List<String> calls = <String>[];
  final List<Map<String, dynamic>> callArguments = <Map<String, dynamic>>[];
  Future<Map<String, dynamic>> Function(
    String method,
    Map<String, dynamic> arguments,
  )? handler;

  @override
  Future<Map<String, dynamic>> invoke(
    String method, [
    Map<String, dynamic> arguments = const <String, dynamic>{},
  ]) async {
    calls.add(method);
    callArguments.add(Map<String, dynamic>.from(arguments));
    if (handler != null) {
      return handler!(method, arguments);
    }
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

  test('readSensors waits across a >3s first-time OS authorization prompt and returns numeric data', () async {
    final platform = _RecordingHardwarePlatform(<String, Map<String, dynamic>>{});
    platform.handler = (method, arguments) async {
      if (method == 'readSensors') {
        await Future<void>.delayed(const Duration(milliseconds: 3300));
        return <String, dynamic>{
          'ok': true,
          'realSensors': true,
          'accelX': 0.25,
          'accelY': -0.05,
          'accelZ': 0.11,
        };
      }
      return <String, dynamic>{'ok': true};
    };

    final registry = PocketHostRegistry();
    final host = PocketHost(
      registry: registry,
      streams: PocketStreamBridge(send: (_, __) => true),
      allowedCapabilities: HardwareCapabilities.all,
      send: (_, __) => true,
    );
    final plugin = HardwarePlugin(platform: platform);
    final manager = PocketPluginManager(
      host: host,
      appId: 'test.pocket_hardware.prompt',
      sessionId: 'session-prompt',
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

    final result = await manager.invoke(
      HardwareCapabilities.sensorsRead,
    ) as Map<String, dynamic>;
    expect(result['ok'], isTrue);
    expect(result['accelX'], 0.25);
    expect(platform.calls, equals(<String>['readSensors']));
    expect(platform.callArguments.first['operationId'], 1);
    expect(platform.callArguments.first['timeoutMs'], 16000);

    await manager.dispose();
    host.dispose();
  });

  test('sensor timeout cancels the matching native operationId and subsequent read succeeds', () async {
    final hungRead = Completer<Map<String, dynamic>>();
    var readAttempt = 0;
    final platform = _RecordingHardwarePlatform(<String, Map<String, dynamic>>{});
    platform.handler = (method, arguments) async {
      if (method == 'readSensors') {
        readAttempt += 1;
        if (readAttempt == 1) {
          return hungRead.future;
        }
        return <String, dynamic>{
          'ok': true,
          'realSensors': true,
          'accelX': 0.42,
        };
      }
      if (method == 'requestPermission') {
        return <String, dynamic>{
          'ok': true,
          'permission': 'sensors',
          'granted': false,
          'status': 'denied',
          'realHardware': true,
        };
      }
      return <String, dynamic>{'ok': true, 'cancelled': true};
    };

    final registry = PocketHostRegistry();
    final host = PocketHost(
      registry: registry,
      streams: PocketStreamBridge(send: (_, __) => true),
      allowedCapabilities: HardwareCapabilities.all,
      send: (_, __) => true,
    );
    final plugin = HardwarePlugin(
      platform: platform,
      requestTimeout: const Duration(milliseconds: 40),
    );
    final manager = PocketPluginManager(
      host: host,
      appId: 'test.pocket_hardware.timeout',
      sessionId: 'session-timeout',
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

    await expectLater(
      manager.invoke(HardwareCapabilities.sensorsRead),
      throwsA(
        isA<PocketCapabilityException>().having(
          (error) => error.code,
          'code',
          'hardware_timeout',
        ),
      ),
    );
    await Future<void>.delayed(const Duration(milliseconds: 10));
    expect(
      platform.calls,
      equals(<String>['readSensors', 'cancelSensorOperation']),
    );
    expect(
      platform.callArguments[1]['operationId'],
      equals(platform.callArguments[0]['operationId']),
    );

    final deniedPerm = await manager.invoke(
      HardwareCapabilities.requestPermission,
      const <String, dynamic>{'permission': HardwarePermissions.sensors},
    ) as Map<String, dynamic>;
    expect(deniedPerm['granted'], isFalse);
    expect(deniedPerm['status'], 'denied');

    final secondRead = await manager.invoke(
      HardwareCapabilities.sensorsRead,
    ) as Map<String, dynamic>;
    expect(secondRead['ok'], isTrue);
    expect(secondRead['accelX'], 0.42);

    await manager.dispose();
    host.dispose();
  });
}
