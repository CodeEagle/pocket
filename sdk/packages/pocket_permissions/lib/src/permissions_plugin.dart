import 'dart:async';

import 'package:device_info_plus/device_info_plus.dart';
import 'package:flutter/foundation.dart';
import 'package:permission_handler_platform_interface/permission_handler_platform_interface.dart';
import 'package:pocket_services/pocket_services.dart';

const String pocketPermissionsPluginId = 'flutter.permission_handler';

abstract final class PocketPermissionNames {
  static const String camera = 'camera';
  static const String photos = 'photos';
  static const String photosAddOnly = 'photosAddOnly';
  static const String bluetoothScan = 'bluetoothScan';
  static const String bluetoothConnect = 'bluetoothConnect';
  static const String bluetooth = 'bluetooth';
  static const String locationWhenInUse = 'locationWhenInUse';
  static const String microphone = 'microphone';
  static const String sensors = 'sensors';

  /// The names accepted by the SDK hardware policy as aliases. Biometrics and
  /// network intentionally do not appear: they are not runtime permissions
  /// handled by this provider.
  static const String hardwareCamera = 'hardware.camera';
  static const String hardwarePhotos = 'hardware.photos';
  static const String hardwareBluetooth = 'hardware.bluetooth';
  static const String hardwareLocation = 'hardware.location';
  static const String hardwareMicrophone = 'hardware.microphone';
  static const String hardwareSensors = 'hardware.sensors';

  static const Set<String> all = <String>{
    camera,
    photos,
    photosAddOnly,
    bluetoothScan,
    bluetoothConnect,
    bluetooth,
    locationWhenInUse,
    microphone,
    sensors,
    hardwareCamera,
    hardwarePhotos,
    hardwareBluetooth,
    hardwareLocation,
    hardwareMicrophone,
    hardwareSensors,
  };

  static const Set<String> hardwareAliases = <String>{
    hardwareCamera,
    hardwarePhotos,
    hardwareBluetooth,
    hardwareLocation,
    hardwareMicrophone,
    hardwareSensors,
  };
}

abstract final class PocketPermissionsCapabilities {
  static const String status = 'permissions.status';
  static const String request = 'permissions.request';
  static const String openSettings = 'permissions.openSettings';

  static const Set<String> all = <String>{status, request, openSettings};
}

/// A narrow seam over permission_handler's platform interface. It keeps tests
/// on the real plugin contract without inventing a fake method channel or a
/// second permission state machine.
final class PocketSystemPermissions {
  PocketSystemPermissions({
    PermissionHandlerPlatform? platform,
    PocketDeviceInfo? deviceInfo,
  }) : _platform = platform ?? PermissionHandlerPlatform.instance,
       _deviceInfo = deviceInfo ?? const DeviceInfoPlusPocketDeviceInfo();

  final PermissionHandlerPlatform _platform;
  final PocketDeviceInfo _deviceInfo;

  Future<Map<String, dynamic>> status(String policyKey) async {
    if (_isAndroidNotRequiredAlias(policyKey)) {
      return _notRequiredResult(policyKey);
    }
    final targets = await _targets(policyKey);
    final statuses = await Future.wait(
      targets.map(_platform.checkPermissionStatus),
    );
    return _result(policyKey, targets, statuses);
  }

  Future<Map<String, dynamic>> request(String policyKey) async {
    if (_isAndroidNotRequiredAlias(policyKey)) {
      return _notRequiredResult(policyKey);
    }
    final targets = await _targets(policyKey);
    final values = await _platform.requestPermissions(targets);
    final statuses = targets
        .map((target) => values[target] ?? PermissionStatus.denied)
        .toList(growable: false);
    return _result(policyKey, targets, statuses);
  }

  Future<Map<String, dynamic>> openSettings() async {
    final opened = await _platform.openAppSettings();
    return <String, dynamic>{
      'ok': opened,
      'opened': opened,
      'realHardware': true,
    };
  }

  Future<List<Permission>> _targets(String policyKey) async {
    if (!PocketPermissionNames.all.contains(policyKey)) {
      throw const PocketCapabilityException(
        'invalid_permission',
        'unsupported operating-system permission',
      );
    }
    if (policyKey == PocketPermissionNames.bluetooth ||
        policyKey == PocketPermissionNames.bluetoothScan ||
        policyKey == PocketPermissionNames.bluetoothConnect ||
        policyKey == PocketPermissionNames.hardwareBluetooth) {
      if (_deviceInfo.isIOS || !_deviceInfo.isAndroid) {
        return const <Permission>[Permission.bluetooth];
      }
      final sdk = await _deviceInfo.androidSdkInt;
      if (sdk >= 31) {
        if (policyKey == PocketPermissionNames.bluetoothScan) {
          return const <Permission>[Permission.bluetoothScan];
        }
        if (policyKey == PocketPermissionNames.bluetoothConnect) {
          return const <Permission>[Permission.bluetoothConnect];
        }
        return const <Permission>[
          Permission.bluetoothScan,
          Permission.bluetoothConnect,
        ];
      }
      // Android 11 and below gate BLE discovery through location. This is
      // requested only for an explicit Bluetooth policy key.
      return const <Permission>[Permission.locationWhenInUse];
    }
    return <Permission>[_target(policyKey)];
  }

  bool _isAndroidNotRequiredAlias(String policyKey) {
    if (!_deviceInfo.isAndroid) return false;
    return policyKey == PocketPermissionNames.hardwarePhotos ||
        policyKey == PocketPermissionNames.hardwareSensors;
  }

  static Map<String, dynamic> _notRequiredResult(String policyKey) =>
      <String, dynamic>{
        'ok': true,
        'permission': policyKey,
        'status': 'notRequired',
        'runtimePermissionRequired': false,
        // App-private photos and Android sensor reads are not OS grants. A
        // true value here means the policy is satisfied, not that a sensor
        // or photo is present on the device.
        'granted': true,
        'realHardware': true,
      };

  Map<String, dynamic> _result(
    String policyKey,
    List<Permission> targets,
    List<PermissionStatus> values,
  ) {
    final value = _aggregate(values);
    final granted = values.isNotEmpty &&
        values.every((status) => status == PermissionStatus.granted);
    return <String, dynamic>{
      // `ok` reports that permission_handler completed. A user denial is a
      // valid status result and is represented by `granted: false`.
      'ok': true,
      'permission': policyKey,
      'status': value.name,
      'granted': granted,
      if (values.any((status) => status == PermissionStatus.limited))
        'limited': true,
      if (targets.length > 1)
        'platformPermissions': List<String>.unmodifiable(
          targets.map((target) => target.value.toString()),
        ),
      'realHardware': true,
    };
  }

  static PermissionStatus _aggregate(List<PermissionStatus> values) {
    if (values.isEmpty) return PermissionStatus.denied;
    if (values.every((value) => value == PermissionStatus.granted)) {
      return PermissionStatus.granted;
    }
    if (values.any((value) => value == PermissionStatus.permanentlyDenied)) {
      return PermissionStatus.permanentlyDenied;
    }
    if (values.any((value) => value == PermissionStatus.restricted)) {
      return PermissionStatus.restricted;
    }
    if (values.any((value) => value == PermissionStatus.denied)) {
      return PermissionStatus.denied;
    }
    if (values.any((value) => value == PermissionStatus.limited)) {
      return PermissionStatus.limited;
    }
    return values.first;
  }

  static Permission _target(String policyKey) {
    return switch (policyKey) {
      PocketPermissionNames.camera || PocketPermissionNames.hardwareCamera =>
        Permission.camera,
      PocketPermissionNames.photos => Permission.photos,
      PocketPermissionNames.photosAddOnly ||
      PocketPermissionNames.hardwarePhotos => Permission.photosAddOnly,
      PocketPermissionNames.bluetoothScan => Permission.bluetoothScan,
      PocketPermissionNames.bluetoothConnect => Permission.bluetoothConnect,
      PocketPermissionNames.bluetooth || PocketPermissionNames.hardwareBluetooth =>
        Permission.bluetooth,
      PocketPermissionNames.locationWhenInUse ||
      PocketPermissionNames.hardwareLocation => Permission.locationWhenInUse,
      PocketPermissionNames.microphone ||
      PocketPermissionNames.hardwareMicrophone => Permission.microphone,
      PocketPermissionNames.sensors || PocketPermissionNames.hardwareSensors =>
        Permission.sensors,
      _ => throw const PocketCapabilityException(
        'invalid_permission',
        'unsupported operating-system permission',
      ),
    };
  }
}

abstract interface class PocketDeviceInfo {
  bool get isAndroid;
  bool get isIOS;
  Future<int> get androidSdkInt;
}

/// Reads only the Android SDK fact needed to choose permission_handler's BLE
/// permission set. It does not retain permission state or request permissions.
final class DeviceInfoPlusPocketDeviceInfo implements PocketDeviceInfo {
  const DeviceInfoPlusPocketDeviceInfo({DeviceInfoPlugin? plugin})
    : _plugin = plugin;

  final DeviceInfoPlugin? _plugin;

  @override
  bool get isAndroid => defaultTargetPlatform == TargetPlatform.android;

  @override
  bool get isIOS => defaultTargetPlatform == TargetPlatform.iOS;

  @override
  Future<int> get androidSdkInt async {
    if (!isAndroid) return 0;
    final info = await (_plugin ?? DeviceInfoPlugin()).androidInfo;
    return info.version.sdkInt;
  }
}

/// Pocket plugin exposing [PocketSystemPermissions] through the existing
/// capability admission and lifecycle machinery.
final class PocketPermissionsPlugin extends PocketPlugin {
  PocketPermissionsPlugin({
    Iterable<String> allowedPermissions = const <String>[],
  PocketSystemPermissions? service,
    PermissionHandlerPlatform? platform,
    PocketDeviceInfo? deviceInfo,
  }) : _allowedPermissions = _normalizeAllowed(allowedPermissions),
       service = service ??
           PocketSystemPermissions(platform: platform, deviceInfo: deviceInfo);

  final Set<String> _allowedPermissions;
  final PocketSystemPermissions service;
  PocketPluginContext? _context;
  bool _disposed = false;

  Set<String> get allowedPermissions =>
      Set<String>.unmodifiable(_allowedPermissions);

  @override
  PocketPluginDescriptor get descriptor => PocketPluginDescriptor(
    id: pocketPermissionsPluginId,
    version: '0.1.0',
    description: 'Real operating-system permissions via permission_handler',
    optionalPermissions: _allowedPermissions,
    capabilities: <String, PocketPluginCapability>{
      PocketPermissionsCapabilities.status: PocketPluginCapability(
        name: PocketPermissionsCapabilities.status,
        kind: PocketCapabilityKind.request,
        optionalPermissions: _allowedPermissions,
        schema: _permissionCapabilitySchema,
      ),
      PocketPermissionsCapabilities.request: PocketPluginCapability(
        name: PocketPermissionsCapabilities.request,
        kind: PocketCapabilityKind.request,
        optionalPermissions: _allowedPermissions,
        schema: _permissionCapabilitySchema,
      ),
      PocketPermissionsCapabilities.openSettings: PocketPluginCapability(
        name: PocketPermissionsCapabilities.openSettings,
        kind: PocketCapabilityKind.request,
        optionalPermissions: _allowedPermissions,
      ),
    },
  );

  @override
  void register(PocketPluginContext context) {
    _context = context;
    context.registerRequest(PocketPermissionsCapabilities.status, (params) {
      final policyKey = _permissionParam(params);
      _admit(policyKey);
      return service.status(policyKey);
    });
    context.registerRequest(PocketPermissionsCapabilities.request, (params) {
      final policyKey = _permissionParam(params);
      _admit(policyKey);
      return service.request(policyKey);
    });
    context.registerRequest(PocketPermissionsCapabilities.openSettings, (params) {
      if (params.isNotEmpty) {
        throw const PocketCapabilityException(
          'invalid_argument',
          'permissions.openSettings does not accept parameters',
        );
      }
      _admitSettings();
      return service.openSettings();
    });
  }

  @override
  Future<void> dispose() async {
    _disposed = true;
    _context = null;
  }

  void _admit(String permission) {
    if (_disposed) {
      throw const PocketCapabilityException(
        'plugin_disposed',
        'permission plugin is disposed',
      );
    }
    if (!_allowedPermissions.contains(permission)) {
      throw const PocketCapabilityException(
        'permission_denied',
        'permission is outside the trusted host allowlist',
      );
    }
    final context = _context;
    if (context != null && !context.grantedPermissions.contains(permission)) {
      throw const PocketCapabilityException(
        'permission_denied',
        'permission was not requested and granted by the guest manifest',
      );
    }
  }

  void _admitSettings() {
    if (_disposed) {
      throw const PocketCapabilityException(
        'plugin_disposed',
        'permission plugin is disposed',
      );
    }
    final context = _context;
    if (_allowedPermissions.isEmpty ||
        (context != null &&
            _allowedPermissions
                .intersection(context.grantedPermissions)
                .isEmpty)) {
      throw const PocketCapabilityException(
        'permission_denied',
        'no trusted permission is available for app settings',
      );
    }
  }

  String _permissionParam(Map<String, dynamic> params) {
    if (params.length != 1 || params['policyKey'] is! String) {
      throw const PocketCapabilityException(
        'invalid_argument',
        'policyKey must be the only string parameter',
      );
    }
    final value = params['policyKey'] as String;
    if (!PocketPermissionNames.all.contains(value)) {
      throw const PocketCapabilityException(
        'invalid_permission',
        'unsupported operating-system permission',
      );
    }
    return value;
  }

  static Set<String> _normalizeAllowed(Iterable<String> permissions) {
    final values = permissions.toSet();
    if (!values.every(PocketPermissionNames.all.contains)) {
      throw ArgumentError.value(
        permissions,
        'allowedPermissions',
        'contains an unsupported permission or a non-runtime permission',
      );
    }
    return Set<String>.unmodifiable(values);
  }
}

const PocketPluginSchema _permissionRequestSchema = PocketPluginSchema.object(
  properties: <String, PocketPluginSchema>{
    'policyKey': PocketPluginSchema.string(),
  },
  required: <String>{'policyKey'},
);

const PocketPluginCapabilitySchema _permissionCapabilitySchema =
    PocketPluginCapabilitySchema(parameters: _permissionRequestSchema);
