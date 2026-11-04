import 'package:flutter_test/flutter_test.dart';
import 'package:permission_handler_platform_interface/permission_handler_platform_interface.dart';
import 'package:pocket_permissions/pocket_permissions.dart';
import 'package:pocket_services/pocket_services.dart';

void main() {
  test('status and request expose real permission_handler states', () async {
    final platform = _FakePermissionPlatform(
      statuses: <int, PermissionStatus>{
        Permission.camera.value: PermissionStatus.granted,
        Permission.photos.value: PermissionStatus.limited,
        Permission.photosAddOnly.value: PermissionStatus.denied,
      },
      requestResult: PermissionStatus.permanentlyDenied,
    );
    final service = PocketSystemPermissions(
      platform: platform,
      deviceInfo: const _FakeDeviceInfo(),
    );

    expect(
      await service.status(PocketPermissionNames.camera),
      <String, dynamic>{
        'ok': true,
        'permission': 'camera',
        'status': 'granted',
        'granted': true,
        'realHardware': true,
      },
    );
    expect(
      await service.status(PocketPermissionNames.photos),
      <String, dynamic>{
        'ok': true,
        'permission': 'photos',
        'status': 'limited',
        'granted': false,
        'limited': true,
        'realHardware': true,
      },
    );
    final denied = await service.request(PocketPermissionNames.camera);
    expect(denied['ok'], isTrue);
    expect(denied['granted'], isFalse);
    expect(denied['status'], 'permanentlyDenied');
    expect(platform.requested, [Permission.camera.value]);
  });

  test('aliases map to the smallest platform permission and unsupported policy is rejected', () async {
    final platform = _FakePermissionPlatform();
    final service = PocketSystemPermissions(
      platform: platform,
      deviceInfo: const _FakeDeviceInfo(),
    );
    await service.status(PocketPermissionNames.hardwarePhotos);
    await service.status(PocketPermissionNames.hardwareBluetooth);
    await service.status(PocketPermissionNames.hardwareLocation);
    expect(platform.checked, [
      Permission.photosAddOnly.value,
      Permission.bluetooth.value,
      Permission.locationWhenInUse.value,
    ]);
    await expectLater(
      service.status('biometrics'),
      throwsA(isA<PocketCapabilityException>()),
    );
  });

  test('Bluetooth selects Android API-specific permissions and iOS aggregate permission', () async {
    final android30Platform = _FakePermissionPlatform();
    final android30 = PocketSystemPermissions(
      platform: android30Platform,
      deviceInfo: const _FakeDeviceInfo(android: true, sdk: 30),
    );
    await android30.status(PocketPermissionNames.bluetooth);
    expect(android30Platform.checked, [Permission.locationWhenInUse.value]);

    final android31Platform = _FakePermissionPlatform();
    final android31 = PocketSystemPermissions(
      platform: android31Platform,
      deviceInfo: const _FakeDeviceInfo(android: true, sdk: 31),
    );
    await android31.request(PocketPermissionNames.bluetooth);
    expect(android31Platform.requested, [
      Permission.bluetoothScan.value,
      Permission.bluetoothConnect.value,
    ]);

    final iosPlatform = _FakePermissionPlatform();
    final ios = PocketSystemPermissions(
      platform: iosPlatform,
      deviceInfo: const _FakeDeviceInfo(ios: true),
    );
    await ios.status(PocketPermissionNames.bluetoothScan);
    expect(iosPlatform.checked, [Permission.bluetooth.value]);
  });

  test('Android hardware photos and sensors aliases are not runtime permissions', () async {
    final platform = _FakePermissionPlatform();
    final service = PocketSystemPermissions(
      platform: platform,
      deviceInfo: const _FakeDeviceInfo(android: true, sdk: 31),
    );
    expect(await service.status(PocketPermissionNames.hardwarePhotos), {
      'ok': true,
      'permission': 'hardware.photos',
      'status': 'notRequired',
      'runtimePermissionRequired': false,
      'granted': true,
      'realHardware': true,
    });
    expect(await service.request(PocketPermissionNames.hardwareSensors), {
      'ok': true,
      'permission': 'hardware.sensors',
      'status': 'notRequired',
      'runtimePermissionRequired': false,
      'granted': true,
      'realHardware': true,
    });
    expect(platform.checked, isEmpty);
    expect(platform.requested, isEmpty);

    final canonical = _FakePermissionPlatform();
    final canonicalService = PocketSystemPermissions(
      platform: canonical,
      deviceInfo: const _FakeDeviceInfo(android: true, sdk: 31),
    );
    await canonicalService.status(PocketPermissionNames.photos);
    await canonicalService.status(PocketPermissionNames.sensors);
    expect(canonical.checked, [Permission.photos.value, Permission.sensors.value]);
  });

  test('openAppSettings forwards to permission_handler without local state', () async {
    final platform = _FakePermissionPlatform(settingsResult: true);
    final service = PocketSystemPermissions(platform: platform);
    expect(await service.openSettings(), {
      'ok': true,
      'opened': true,
      'realHardware': true,
    });
    expect(platform.openSettingsCalls, 1);
  });

  test('plugin admits only trusted, guest-requested permissions', () async {
    final platform = _FakePermissionPlatform(
      statuses: <int, PermissionStatus>{
        Permission.camera.value: PermissionStatus.granted,
      },
    );
    final plugin = PocketPermissionsPlugin(
      platform: platform,
      allowedPermissions: const <String>{PocketPermissionNames.hardwareCamera},
    );
    final registry = PocketHostRegistry();
    final context = PocketPluginContext(
      plugin: plugin.descriptor,
      appId: 'test.app',
      sessionId: 'test-session',
      registry: registry,
      grantedPermissionsLookup: () =>
          const <String>{PocketPermissionNames.hardwareCamera},
    );
    plugin.register(context);
    context.restore();
    final statusRegistration = registry.registrationFor(
      PocketPermissionsCapabilities.status,
    );
    expect(statusRegistration, isNotNull);
    final status = await statusRegistration!.request!(<String, dynamic>{
      'policyKey': PocketPermissionNames.hardwareCamera,
    });
    expect((status as Map)['granted'], true);
    await expectLater(
      statusRegistration.request!(<String, dynamic>{
        'policyKey': PocketPermissionNames.camera,
      }),
      throwsA(
        isA<PocketCapabilityException>().having(
          (error) => error.code,
          'code',
          'permission_denied',
        ),
      ),
    );
    await expectLater(
      statusRegistration.request!(<String, dynamic>{
        'policyKey': PocketPermissionNames.hardwareCamera,
        'extra': true,
      }),
      throwsA(
        isA<PocketCapabilityException>().having(
          (error) => error.code,
          'code',
          'invalid_argument',
        ),
      ),
    );
    context.dispose();
    await plugin.dispose();
  });

  test('openSettings requires a granted permission in the trusted intersection', () async {
    final plugin = PocketPermissionsPlugin(
      allowedPermissions: const <String>{PocketPermissionNames.hardwareCamera},
    );
    final registry = PocketHostRegistry();
    final context = PocketPluginContext(
      plugin: plugin.descriptor,
      appId: 'test.app',
      sessionId: 'settings-session',
      registry: registry,
      grantedPermissionsLookup: () =>
          const <String>{PocketPermissionNames.hardwareLocation},
    );
    plugin.register(context);
    context.restore();
    final registration = registry.registrationFor(
      PocketPermissionsCapabilities.openSettings,
    );
    expect(registration, isNotNull);
    await expectLater(
      registration!.request!(<String, dynamic>{}),
      throwsA(
        isA<PocketCapabilityException>().having(
          (error) => error.code,
          'code',
          'permission_denied',
        ),
      ),
    );
    context.dispose();
    await plugin.dispose();
  });
}

final class _FakePermissionPlatform extends PermissionHandlerPlatform {
  _FakePermissionPlatform({
    Map<int, PermissionStatus>? statuses,
    this.requestResult = PermissionStatus.denied,
    this.settingsResult = false,
  }) : statuses = statuses ?? <int, PermissionStatus>{};

  final Map<int, PermissionStatus> statuses;
  final PermissionStatus requestResult;
  final bool settingsResult;
  final List<int> checked = <int>[];
  final List<int> requested = <int>[];
  int openSettingsCalls = 0;

  @override
  Future<PermissionStatus> checkPermissionStatus(Permission permission) async {
    checked.add(permission.value);
    return statuses[permission.value] ?? PermissionStatus.denied;
  }

  @override
  Future<Map<Permission, PermissionStatus>> requestPermissions(
    List<Permission> permissions,
  ) async {
    requested.addAll(permissions.map((permission) => permission.value));
    return <Permission, PermissionStatus>{
      for (final permission in permissions) permission: requestResult,
    };
  }

  @override
  Future<bool> openAppSettings() async {
    openSettingsCalls++;
    return settingsResult;
  }
}

final class _FakeDeviceInfo implements PocketDeviceInfo {
  const _FakeDeviceInfo({this.android = false, this.ios = false, this.sdk = 0});

  final bool android;
  final bool ios;
  final int sdk;

  @override
  bool get isAndroid => android;

  @override
  bool get isIOS => ios;

  @override
  Future<int> get androidSdkInt async => sdk;
}
