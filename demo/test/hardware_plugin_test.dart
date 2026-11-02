import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:pocket_flutter/src/pocket_model.dart' show PocketEvent;
import 'package:pocket_services/pocket_services.dart';

import 'package:pocket_hardware/pocket_hardware.dart';

void main() {
  test('descriptor exposes only compiled hardware capabilities', () {
    final descriptor = HardwarePlugin().descriptor;
    expect(descriptor.id, hardwarePluginId);
    expect(descriptor.capabilities.keys, containsAll(HardwareCapabilities.all));
    expect(descriptor.permissions, equals(HardwarePermissions.all));
  });

  test(
    'Android-shaped provider responses use the same platform-neutral contract',
    () async {
      final fake = _FakeHardwarePlatform(<String, Map<String, dynamic>>{
        'checkPermissions': <String, dynamic>{
          'ok': true,
          'platform': 'android',
          'permissions': <String, dynamic>{
            'camera': <String, dynamic>{'supported': true, 'granted': true},
          },
        },
        'startCameraPreview': <String, dynamic>{
          'ok': true,
          'platform': 'android',
          'realHardwareCamera': true,
          'textureId': 7,
          'width': 1280,
          'height': 720,
          'lens': 'back',
        },
        'stopCameraPreview': <String, dynamic>{
          'ok': true,
          'platform': 'android',
          'previewActive': false,
        },
      });
      final harness = await _Harness.create(HardwarePlugin(platform: fake));
      try {
        await harness.request(
          HardwareCapabilities.permissions,
          'android-permissions',
        );
        expect(harness.last['ok'], isTrue);
        expect((harness.last['result'] as Map)['platform'], 'android');

        await harness.request(
          HardwareCapabilities.cameraPreviewStart,
          'android-camera',
        );
        expect(harness.last['ok'], isTrue);
        final preview = harness.last['result'] as Map;
        expect(preview['platform'], 'android');
        expect(preview['textureId'], 7);
        expect(fake.calls, contains('startCameraPreview'));

        await harness.request(
          HardwareCapabilities.cameraPreviewStop,
          'android-camera-stop',
        );
        expect(harness.last['ok'], isTrue);
        expect(fake.calls, contains('stopCameraPreview'));
      } finally {
        await harness.dispose();
      }
    },
  );

  test(
    'unsupported native responses are structured errors, never success',
    () async {
      final fake = _FakeHardwarePlatform(<String, Map<String, dynamic>>{
        'readSensors': <String, dynamic>{
          'ok': false,
          'errorCode': 'hardware_unsupported',
          'error': 'motion sensor is unavailable',
        },
      });
      final harness = await _Harness.create(HardwarePlugin(platform: fake));
      try {
        await harness.request(HardwareCapabilities.sensorsRead, 'sensor-1');
        expect(harness.last['ok'], isFalse);
        expect((harness.last['error'] as Map)['code'], 'hardware_unsupported');
      } finally {
        await harness.dispose();
      }
    },
  );

  test(
    'camera texture registration and cutover cleanup are observable',
    () async {
      final fake = _FakeHardwarePlatform(<String, Map<String, dynamic>>{
        'startCameraPreview': <String, dynamic>{
          'ok': true,
          'textureId': 41,
          'width': 1920,
          'height': 1080,
          'lens': 'back',
        },
        'stopCameraPreview': <String, dynamic>{
          'ok': true,
          'previewActive': false,
        },
      });
      final registered = <int>[];
      final released = <int>[];
      final plugin = HardwarePlugin(
        platform: fake,
        onTextureRegistered: registered.add,
        onTextureReleased: released.add,
      );
      final harness = await _Harness.create(plugin);
      try {
        await harness.request(
          HardwareCapabilities.cameraPreviewStart,
          'camera-1',
        );
        expect(harness.last['ok'], isTrue);
        expect((harness.last['result'] as Map)['textureId'], 41);
        expect(registered, <int>[41]);
        await harness.manager.deactivate();
        expect(released, <int>[41]);
        expect(fake.calls, contains('stopCameraPreview'));
      } finally {
        await harness.dispose();
      }
    },
  );

  test('weather uses real coordinates and injected network response', () async {
    Uri? requestedUri;
    final fake = _FakeHardwarePlatform(<String, Map<String, dynamic>>{
      'getCurrentLocation': <String, dynamic>{
        'ok': true,
        'realGps': true,
        'latitude': 1.29,
        'longitude': 103.85,
      },
    });
    final plugin = HardwarePlugin(
      platform: fake,
      weatherFetcher: (uri) async {
        requestedUri = uri;
        return <String, dynamic>{
          'current': <String, dynamic>{'temperature_2m': 29.0},
          'hourly': <String, dynamic>{
            'temperature_2m': <dynamic>[29.0],
          },
          'daily': <String, dynamic>{
            'weather_code': <dynamic>[1],
          },
        };
      },
    );
    final harness = await _Harness.create(plugin);
    try {
      await harness.request(HardwareCapabilities.weatherCurrent, 'weather-1');
      expect(harness.last['ok'], isTrue);
      final result = harness.last['result'] as Map;
      expect(result['source'], 'open-meteo');
      expect(result['realGps'], isTrue);
      expect(requestedUri?.host, 'api.open-meteo.com');
      expect(requestedUri?.queryParameters['latitude'], '1.29');
      expect(requestedUri?.queryParameters['longitude'], '103.85');
    } finally {
      await harness.dispose();
    }
  });

  test('invalid input is rejected before reaching native provider', () async {
    final fake = _FakeHardwarePlatform(<String, Map<String, dynamic>>{});
    final harness = await _Harness.create(HardwarePlugin(platform: fake));
    try {
      await harness.request(
        HardwareCapabilities.bluetoothScan,
        'invalid-1',
        params: <String, dynamic>{'timeoutMs': 1},
      );
      expect(harness.last['ok'], isFalse);
      expect((harness.last['error'] as Map)['code'], 'invalid_argument');
      expect(fake.calls, isEmpty);
    } finally {
      await harness.dispose();
    }
  });

  test(
    'a preview that completes after deactivation cannot authorize a texture',
    () async {
      final fake = _DelayedHardwarePlatform();
      final registered = <int>[];
      final plugin = HardwarePlugin(
        platform: fake,
        onTextureRegistered: registered.add,
      );
      final harness = await _Harness.create(plugin);
      final pending = harness.request(
        HardwareCapabilities.cameraPreviewStart,
        'late-camera',
      );
      await Future<void>.delayed(Duration.zero);
      final deactivating = harness.manager.deactivate();
      fake.start.complete(<String, dynamic>{
        'ok': true,
        'textureId': 77,
        'width': 640,
        'height': 480,
      });
      await Future.wait<void>(<Future<void>>[pending, deactivating]);
      expect(registered, isEmpty);
      expect(fake.calls, contains('stopCameraPreview'));
      expect(fake.calls, contains('disposeSession'));
      await harness.dispose();
    },
  );

  test('a timed-out preview ignores its late native result', () async {
    final fake = _DelayedHardwarePlatform();
    final registered = <int>[];
    final harness = await _Harness.create(
      HardwarePlugin(
        platform: fake,
        requestTimeout: const Duration(milliseconds: 10),
        onTextureRegistered: registered.add,
      ),
    );
    try {
      await harness.request(
        HardwareCapabilities.cameraPreviewStart,
        'timeout-camera',
      );
      expect(harness.last['ok'], isFalse);
      expect((harness.last['error'] as Map)['code'], 'hardware_timeout');
      fake.start.complete(<String, dynamic>{
        'ok': true,
        'textureId': 88,
        'width': 640,
        'height': 480,
      });
      await Future<void>.delayed(const Duration(milliseconds: 20));
      expect(registered, isEmpty);
    } finally {
      await harness.dispose();
    }
  });

  test('a timed-out permission probe ignores a late native result', () async {
    final fake = _DelayedPermissionPlatform();
    final harness = await _Harness.create(
      HardwarePlugin(
        platform: fake,
        requestTimeout: const Duration(milliseconds: 10),
      ),
    );
    try {
      await harness.request(
        HardwareCapabilities.permissions,
        'timeout-permission',
      );
      expect(harness.last['ok'], isFalse);
      expect((harness.last['error'] as Map)['code'], 'hardware_timeout');
      fake.check.complete(<String, dynamic>{
        'ok': true,
        'permissions': <String, dynamic>{
          'camera': <String, dynamic>{'granted': true},
        },
      });
      await Future<void>.delayed(const Duration(milliseconds: 20));
      expect(harness.last['ok'], isFalse);
    } finally {
      await harness.dispose();
    }
  });
}

final class _FakeHardwarePlatform implements HardwarePlatform {
  _FakeHardwarePlatform(this.responses);

  final Map<String, Map<String, dynamic>> responses;
  final List<String> calls = <String>[];

  @override
  Future<Map<String, dynamic>> invoke(
    String method, [
    Map<String, dynamic> arguments = const <String, dynamic>{},
  ]) async {
    calls.add(method);
    return Map<String, dynamic>.from(
      responses[method] ?? <String, dynamic>{'ok': true},
    );
  }
}

final class _DelayedHardwarePlatform implements HardwarePlatform {
  final Completer<Map<String, dynamic>> start =
      Completer<Map<String, dynamic>>();
  final List<String> calls = <String>[];

  @override
  Future<Map<String, dynamic>> invoke(
    String method, [
    Map<String, dynamic> arguments = const <String, dynamic>{},
  ]) {
    calls.add(method);
    if (method == 'startCameraPreview') return start.future;
    return Future<Map<String, dynamic>>.value(<String, dynamic>{'ok': true});
  }
}

final class _DelayedPermissionPlatform implements HardwarePlatform {
  final Completer<Map<String, dynamic>> check =
      Completer<Map<String, dynamic>>();

  @override
  Future<Map<String, dynamic>> invoke(
    String method, [
    Map<String, dynamic> arguments = const <String, dynamic>{},
  ]) {
    if (method == 'checkPermissions') return check.future;
    return Future<Map<String, dynamic>>.value(<String, dynamic>{'ok': true});
  }
}

final class _Harness {
  _Harness(this.plugin, this.host, this.manager, this.sent);

  final HardwarePlugin plugin;
  final PocketHost host;
  final PocketPluginManager manager;
  final List<Map<String, dynamic>> sent;

  Map<String, dynamic> get last => sent.last;

  static Future<_Harness> create(HardwarePlugin plugin) async {
    final sent = <Map<String, dynamic>>[];
    final registry = PocketHostRegistry();
    final streams = PocketStreamBridge(send: (_, __) => true);
    final host = PocketHost(
      registry: registry,
      streams: streams,
      allowedCapabilities: HardwareCapabilities.all,
      send: (method, params) {
        sent.add(<String, dynamic>{'method': method, ...params});
        return true;
      },
    );
    final manager = PocketPluginManager(
      host: host,
      appId: 'test.hardware',
      sessionId: 'hardware-test-session',
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
    return _Harness(plugin, host, manager, sent);
  }

  Future<void> request(
    String capability,
    String requestId, {
    Map<String, dynamic> params = const <String, dynamic>{},
  }) async {
    await host.handle(
      PocketEvent(
        id: requestId,
        method: 'host.request',
        params: <String, dynamic>{
          'requestId': requestId,
          'capability': capability,
          'params': params,
        },
      ),
    );
  }

  Future<void> dispose() async {
    await manager.dispose();
    host.dispose();
  }
}
