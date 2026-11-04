import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math' as math;

import 'package:flutter/services.dart';
import 'package:pocket_services/pocket_services.dart';

/// The compiled-in iOS and Android hardware provider.  A guest can only reach these
/// methods through the signed capability/permission negotiation; no guest
/// package can provide or load native code.
const String hardwarePluginId = 'flutter.hardware';
const String hardwareMethodChannelName = 'com.pocketnexus.host/hardware';
const String hardwareEventsChannelName = 'com.pocketnexus.host/hardware/events';

enum HardwareFeature {
  camera,
  bluetooth,
  sensors,
  location,
  biometrics,
  weather,
}

abstract final class HardwareFeatures {
  static const all = <HardwareFeature>{
    HardwareFeature.camera,
    HardwareFeature.bluetooth,
    HardwareFeature.sensors,
    HardwareFeature.location,
    HardwareFeature.biometrics,
    HardwareFeature.weather,
  };

  static Set<String> capabilities(HardwareFeature feature) => switch (feature) {
    HardwareFeature.camera => <String>{
      HardwareCapabilities.cameraPreviewStart,
      HardwareCapabilities.cameraPreviewStop,
      HardwareCapabilities.cameraLensSwitch,
      HardwareCapabilities.cameraFlashToggle,
      HardwareCapabilities.cameraCapture,
      HardwareCapabilities.photosList,
      HardwareCapabilities.photosDelete,
    },
    HardwareFeature.bluetooth => <String>{
      HardwareCapabilities.bluetoothScan,
      HardwareCapabilities.bluetoothConnect,
      HardwareCapabilities.bluetoothRead,
      HardwareCapabilities.bluetoothWrite,
      HardwareCapabilities.bluetoothNotifications,
    },
    HardwareFeature.sensors => <String>{
      HardwareCapabilities.sensorsRead,
      HardwareCapabilities.sensorsWatch,
    },
    HardwareFeature.location => <String>{HardwareCapabilities.locationCurrent},
    HardwareFeature.biometrics => <String>{
      HardwareCapabilities.biometricAuthenticate,
    },
    HardwareFeature.weather => <String>{HardwareCapabilities.weatherCurrent},
  };
}

/// Routes only to native packages selected by the trusted consumer.
HardwarePlatform createHardwarePlatform(Set<HardwareFeature> features) =>
    _HardwarePlatforms(features);

final class _HardwarePlatforms
    implements HardwarePlatform, HardwareStreamingPlatform {
  _HardwarePlatforms(Set<HardwareFeature> features)
    : _platforms = <HardwareFeature, MethodChannelHardwarePlatform>{
        for (final feature in features)
          if (feature != HardwareFeature.weather)
            feature: MethodChannelHardwarePlatform(
              channel: MethodChannel(
                '$hardwareMethodChannelName/${feature.name}',
              ),
              events: EventChannel(
                '$hardwareMethodChannelName/${feature.name}/events',
              ),
            ),
      };

  final Map<HardwareFeature, MethodChannelHardwarePlatform> _platforms;
  Stream<Object?>? _events;

  HardwareFeature _feature(String method, Map<String, dynamic> arguments) {
    if (method == 'startHardwareStream' || method == 'stopHardwareStream') {
      return switch (arguments['kind']) {
        'sensors' => HardwareFeature.sensors,
        'ble.notifications' => HardwareFeature.bluetooth,
        _ => throw const HardwarePlatformException(
          'invalid_argument',
          'hardware stream kind must be sensors or ble.notifications',
        ),
      };
    }
    if (method.contains('Ble')) return HardwareFeature.bluetooth;
    if (method.contains('Sensor')) return HardwareFeature.sensors;
    if (method == 'getCurrentLocation') return HardwareFeature.location;
    if (method == 'authenticateBiometrics') return HardwareFeature.biometrics;
    return HardwareFeature.camera;
  }

  MethodChannelHardwarePlatform _platform(
    String method,
    Map<String, dynamic> arguments,
  ) {
    final feature = _feature(method, arguments);
    final value = _platforms[feature];
    if (value == null) {
      throw HardwarePlatformException(
        'hardware_unsupported',
        '${feature.name} provider was not selected',
      );
    }
    return value;
  }

  @override
  Future<Map<String, dynamic>> invoke(
    String method, [
    Map<String, dynamic> arguments = const {},
  ]) async {
    if (method == 'disposeSession') {
      await Future.wait(
        _platforms.values.map((platform) => platform.invoke(method, arguments)),
      );
      return <String, dynamic>{'ok': true};
    }
    return _platform(method, arguments).invoke(method, arguments);
  }

  @override
  Future<Map<String, dynamic>> startHardwareStream(
    Map<String, dynamic> arguments,
  ) => _platform(
    'startHardwareStream',
    arguments,
  ).startHardwareStream(arguments);

  @override
  Future<Map<String, dynamic>> stopHardwareStream(
    Map<String, dynamic> arguments,
  ) => _platform('stopHardwareStream', arguments).stopHardwareStream(arguments);

  @override
  Stream<Object?> get hardwareEvents => _events ??= _mergedEvents();

  Stream<Object?> _mergedEvents() {
    final subscriptions = <StreamSubscription<Object?>>[];
    late final StreamController<Object?> controller;
    controller = StreamController<Object?>.broadcast(
      onListen: () {
        for (final entry in _platforms.entries) {
          if (entry.key != HardwareFeature.bluetooth &&
              entry.key != HardwareFeature.sensors)
            continue;
          subscriptions.add(
            entry.value.hardwareEvents.listen(
              controller.add,
              onError: controller.addError,
            ),
          );
        }
      },
      onCancel: () {
        for (final subscription in subscriptions) {
          unawaited(subscription.cancel());
        }
        subscriptions.clear();
      },
    );
    return controller.stream;
  }
}

abstract final class HardwarePermissions {
  static const String camera = 'hardware.camera';
  static const String photos = 'hardware.photos';
  static const String bluetooth = 'hardware.bluetooth';
  static const String sensors = 'hardware.sensors';
  static const String biometrics = 'hardware.biometrics';
  static const String location = 'hardware.location';
  static const String microphone = 'hardware.microphone';
  static const String network = 'hardware.network';

  static const Set<String> all = <String>{
    camera,
    photos,
    bluetooth,
    sensors,
    biometrics,
    location,
    microphone,
    network,
  };
}

abstract final class HardwareCapabilities {
  static const String permissions = 'hardware.permissions';
  static const String requestPermission = 'hardware.permissions.request';
  static const String cameraPreviewStart = 'hardware.camera.preview.start';
  static const String cameraPreviewStop = 'hardware.camera.preview.stop';
  static const String cameraLensSwitch = 'hardware.camera.lens.switch';
  static const String cameraFlashToggle = 'hardware.camera.flash.toggle';
  static const String cameraCapture = 'hardware.camera.capture';
  static const String photosList = 'hardware.photos.list';
  static const String photosDelete = 'hardware.photos.delete';
  static const String bluetoothScan = 'hardware.bluetooth.scan';
  static const String bluetoothConnect = 'hardware.bluetooth.connect';
  static const String bluetoothRead = 'hardware.bluetooth.read';
  static const String bluetoothWrite = 'hardware.bluetooth.write';
  static const String bluetoothNotifications =
      'hardware.bluetooth.notifications';
  static const String sensorsRead = 'hardware.sensors.read';
  static const String sensorsWatch = 'hardware.sensors.watch';
  static const String biometricAuthenticate =
      'hardware.biometrics.authenticate';
  static const String locationCurrent = 'hardware.location.current';
  static const String weatherCurrent = 'hardware.weather.current';

  static const Set<String> all = <String>{
    permissions,
    requestPermission,
    cameraPreviewStart,
    cameraPreviewStop,
    cameraLensSwitch,
    cameraFlashToggle,
    cameraCapture,
    photosList,
    photosDelete,
    bluetoothScan,
    bluetoothConnect,
    bluetoothRead,
    bluetoothWrite,
    bluetoothNotifications,
    sensorsRead,
    sensorsWatch,
    biometricAuthenticate,
    locationCurrent,
    weatherCurrent,
  };
}

typedef HardwareTextureCallback = void Function(int textureId);

/// Small platform boundary used by the provider and by unit tests.  The
/// production implementation is a Flutter method channel; tests can provide
/// a deterministic implementation without claiming that hardware succeeded.
abstract interface class HardwarePlatform {
  Future<Map<String, dynamic>> invoke(
    String method, [
    Map<String, dynamic> arguments = const <String, dynamic>{},
  ]);
}

/// Optional extension implemented by a platform boundary that can deliver
/// long-lived native hardware events. Existing [HardwarePlatform] fakes remain
/// valid and simply report streaming as unavailable when this interface is not
/// implemented.
abstract interface class HardwareStreamingPlatform {
  /// One process-local broadcast source for all native hardware streams.
  /// Events are maps containing `streamId` and one of `data`, `error`, or
  /// `done`; consumers must route only their own stream id.
  Stream<Object?> get hardwareEvents;

  Future<Map<String, dynamic>> startHardwareStream(
    Map<String, dynamic> arguments,
  );

  /// Receives kind, streamId and the trusted sessionId, just like start.
  Future<Map<String, dynamic>> stopHardwareStream(
    Map<String, dynamic> arguments,
  );
}

final class HardwarePlatformException implements Exception {
  const HardwarePlatformException(this.code, this.message);

  final String code;
  final String message;

  @override
  String toString() => 'HardwarePlatformException($code): $message';
}

final class MethodChannelHardwarePlatform
    implements HardwarePlatform, HardwareStreamingPlatform {
  MethodChannelHardwarePlatform({MethodChannel? channel, EventChannel? events})
    : channel = channel ?? const MethodChannel(hardwareMethodChannelName),
      events = events ?? const EventChannel(hardwareEventsChannelName),
      _defaultPlatform = channel == null && events == null
          ? _HardwarePlatforms(HardwareFeatures.all)
          : null;

  static final Map<String, Stream<Object?>> _sharedHardwareEvents =
      <String, Stream<Object?>>{};

  final MethodChannel channel;
  final EventChannel events;
  final _HardwarePlatforms? _defaultPlatform;

  @override
  Stream<Object?> get hardwareEvents =>
      _defaultPlatform?.hardwareEvents ??
      _sharedHardwareEvents.putIfAbsent(
        events.name,
        () => events.receiveBroadcastStream(),
      );

  @override
  Future<Map<String, dynamic>> startHardwareStream(
    Map<String, dynamic> arguments,
  ) => invoke('startHardwareStream', arguments);

  @override
  Future<Map<String, dynamic>> stopHardwareStream(
    Map<String, dynamic> arguments,
  ) => invoke('stopHardwareStream', arguments);

  @override
  Future<Map<String, dynamic>> invoke(
    String method, [
    Map<String, dynamic> arguments = const <String, dynamic>{},
  ]) async {
    if (_defaultPlatform case final platform?) {
      return platform.invoke(method, arguments);
    }
    try {
      final value = await channel.invokeMethod<Object?>(method, arguments);
      if (value is! Map) {
        throw const HardwarePlatformException(
          'hardware_invalid_response',
          'native hardware provider returned a non-object response',
        );
      }
      return Map<String, dynamic>.from(value);
    } on HardwarePlatformException {
      rethrow;
    } on MissingPluginException catch (error) {
      throw HardwarePlatformException(
        'hardware_unsupported_platform',
        error.message ?? 'hardware provider is unavailable on this platform',
      );
    } on PlatformException catch (error) {
      throw HardwarePlatformException(
        error.code.isEmpty ? 'hardware_platform_error' : error.code,
        error.message ?? 'native hardware provider failed',
      );
    }
  }
}

typedef HardwarePermissionHandler =
    Future<Map<String, dynamic>> Function(
      String permission, {
      required bool request,
    });

typedef HardwareWeatherFetcher = Future<Map<String, dynamic>> Function(Uri uri);

String _newSensorOwnerToken() {
  final random = math.Random.secure();
  return List<int>.generate(
    16,
    (_) => random.nextInt(256),
  ).map((byte) => byte.toRadixString(16).padLeft(2, '0')).join();
}

final class _SensorOperationIdentity {
  const _SensorOperationIdentity(this.ownerToken, this.operationId);

  final String ownerToken;
  final int operationId;

  Map<String, dynamic> toNativeArguments() => <String, dynamic>{
    'ownerToken': ownerToken,
    'operationId': operationId,
  };
}

final class _HardwareStreamBinding {
  _HardwareStreamBinding(this.streamId, this.controller, this._stop);

  final String streamId;
  final StreamController<Object?> controller;
  final Future<void> Function() _stop;
  StreamSubscription<Object?>? eventsSubscription;
  Future<void>? startFuture;

  Future<void> stop() => _stop();
}

const PocketPluginSchema _bleSelectorSchema = PocketPluginSchema.object(
  properties: <String, PocketPluginSchema>{
    'deviceId': PocketPluginSchema.string(),
    'serviceUuid': PocketPluginSchema.string(),
    'characteristicUuid': PocketPluginSchema.string(),
  },
  required: <String>{'deviceId', 'serviceUuid', 'characteristicUuid'},
);

const PocketPluginSchema _bleWriteSchema = PocketPluginSchema.object(
  properties: <String, PocketPluginSchema>{
    'deviceId': PocketPluginSchema.string(),
    'serviceUuid': PocketPluginSchema.string(),
    'characteristicUuid': PocketPluginSchema.string(),
    'value': PocketPluginSchema.array(PocketPluginSchema.integer()),
    'withResponse': PocketPluginSchema.boolean(),
  },
  required: <String>{'deviceId', 'serviceUuid', 'characteristicUuid', 'value'},
);

const PocketPluginSchema _sensorWatchSchema = PocketPluginSchema.object(
  properties: <String, PocketPluginSchema>{
    'samplingHz': PocketPluginSchema.integer(),
  },
);

/// The network side of weather remains a host-owned service.  It consumes a
/// real location (or explicit caller coordinates) and never supplies seeded or
/// simulated values when platform/network support is missing.
class HardwareCapabilityPlugin extends PocketPlugin {
  HardwareCapabilityPlugin({
    HardwarePlatform? platform,
    HardwarePermissionHandler? permissionHandler,
    Set<HardwareFeature> features = HardwareFeatures.all,
    this.pluginId = hardwarePluginId,
    this.includeLegacyPermissions = false,
    HardwareWeatherFetcher? weatherFetcher,
    this.onTextureRegistered,
    this.onTextureReleased,
    this.requestTimeout = const Duration(seconds: 16),
    Set<String>? grantedPermissions,
  }) : features = Set<HardwareFeature>.unmodifiable(features),
       _platform = platform ?? createHardwarePlatform(features),
       _permissionHandler = permissionHandler,
       _weatherFetcher = weatherFetcher ?? _fetchOpenMeteo,
       _grantedPermissions = grantedPermissions;

  final Set<HardwareFeature> features;
  final String pluginId;
  final bool includeLegacyPermissions;
  final HardwarePermissionHandler? _permissionHandler;
  final HardwarePlatform _platform;
  final HardwareWeatherFetcher _weatherFetcher;
  final HardwareTextureCallback? onTextureRegistered;
  final HardwareTextureCallback? onTextureReleased;
  final Duration requestTimeout;
  final Set<String>? _grantedPermissions;
  // The native iOS manager is process-wide, while a host may construct more
  // than one HardwarePlugin (including from different isolates). A secure
  // per-plugin token keeps an old timeout from cancelling a newer plugin's
  // operation when both local epochs happen to start at one.
  final String _sensorOwnerToken = _newSensorOwnerToken();
  int? _textureId;
  bool _stopped = true;
  int _previewEpoch = 0;
  int _sensorOperationEpoch = 0;
  Future<void> _cameraTail = Future<void>.value();
  PocketPluginContext? _activeContext;
  String? _trustedSessionId;
  final Map<String, _HardwareStreamBinding> _activeHardwareStreams =
      <String, _HardwareStreamBinding>{};

  void _checkPermission(String permission) {
    if (_grantedPermissions != null &&
        !_grantedPermissions.contains(permission)) {
      throw PocketCapabilityException(
        'permission_denied',
        'permission $permission is not granted',
      );
    }
    if (_activeContext != null &&
        !_activeContext!.grantedPermissions.contains(permission)) {
      throw PocketCapabilityException(
        'permission_denied',
        'permission $permission is not granted',
      );
    }
  }

  PocketPluginDescriptor get _fullDescriptor => const PocketPluginDescriptor(
    id: hardwarePluginId,
    version: '1.0.0',
    description:
        'Compiled host camera, photos, BLE, sensors, biometrics, location and weather provider',
    permissions: const <String>{},
    optionalPermissions: HardwarePermissions.all,
    limits: PocketPluginLimits(
      maxConcurrentRequests: 4,
      maxResponseBytes: 512 * 1024,
    ),
    capabilities: <String, PocketPluginCapability>{
      HardwareCapabilities.permissions: PocketPluginCapability(
        name: HardwareCapabilities.permissions,
        kind: PocketCapabilityKind.request,
        permissions: const <String>{},
      ),
      HardwareCapabilities.requestPermission: PocketPluginCapability(
        name: HardwareCapabilities.requestPermission,
        kind: PocketCapabilityKind.request,
        permissions: const <String>{},
        optionalPermissions: HardwarePermissions.all,
      ),
      HardwareCapabilities.cameraPreviewStart: PocketPluginCapability(
        name: HardwareCapabilities.cameraPreviewStart,
        kind: PocketCapabilityKind.request,
        permissions: const <String>{HardwarePermissions.camera},
      ),
      HardwareCapabilities.cameraPreviewStop: PocketPluginCapability(
        name: HardwareCapabilities.cameraPreviewStop,
        kind: PocketCapabilityKind.request,
        permissions: const <String>{HardwarePermissions.camera},
      ),
      HardwareCapabilities.cameraLensSwitch: PocketPluginCapability(
        name: HardwareCapabilities.cameraLensSwitch,
        kind: PocketCapabilityKind.request,
        permissions: const <String>{HardwarePermissions.camera},
      ),
      HardwareCapabilities.cameraFlashToggle: PocketPluginCapability(
        name: HardwareCapabilities.cameraFlashToggle,
        kind: PocketCapabilityKind.request,
        permissions: const <String>{HardwarePermissions.camera},
      ),
      HardwareCapabilities.cameraCapture: PocketPluginCapability(
        name: HardwareCapabilities.cameraCapture,
        kind: PocketCapabilityKind.request,
        permissions: const <String>{HardwarePermissions.camera},
      ),
      HardwareCapabilities.photosList: PocketPluginCapability(
        name: HardwareCapabilities.photosList,
        kind: PocketCapabilityKind.request,
        permissions: const <String>{HardwarePermissions.photos},
      ),
      HardwareCapabilities.photosDelete: PocketPluginCapability(
        name: HardwareCapabilities.photosDelete,
        kind: PocketCapabilityKind.request,
        permissions: const <String>{HardwarePermissions.photos},
      ),
      HardwareCapabilities.bluetoothScan: PocketPluginCapability(
        name: HardwareCapabilities.bluetoothScan,
        kind: PocketCapabilityKind.request,
        permissions: const <String>{HardwarePermissions.bluetooth},
      ),
      HardwareCapabilities.bluetoothConnect: PocketPluginCapability(
        name: HardwareCapabilities.bluetoothConnect,
        kind: PocketCapabilityKind.request,
        permissions: const <String>{HardwarePermissions.bluetooth},
      ),
      HardwareCapabilities.bluetoothRead: PocketPluginCapability(
        name: HardwareCapabilities.bluetoothRead,
        kind: PocketCapabilityKind.request,
        permissions: const <String>{HardwarePermissions.bluetooth},
        schema: PocketPluginCapabilitySchema(
          parameters: _bleSelectorSchema,
          result: PocketPluginSchema.object(
            properties: <String, PocketPluginSchema>{
              'ok': PocketPluginSchema.boolean(),
              'realBle': PocketPluginSchema.boolean(),
              'device': PocketPluginSchema.string(),
              'deviceId': PocketPluginSchema.string(),
              'serviceUuid': PocketPluginSchema.string(),
              'characteristicUuid': PocketPluginSchema.string(),
              'value': PocketPluginSchema.array(PocketPluginSchema.integer()),
              'bytesRead': PocketPluginSchema.integer(),
            },
          ),
        ),
      ),
      HardwareCapabilities.bluetoothWrite: PocketPluginCapability(
        name: HardwareCapabilities.bluetoothWrite,
        kind: PocketCapabilityKind.request,
        permissions: const <String>{HardwarePermissions.bluetooth},
        schema: PocketPluginCapabilitySchema(
          parameters: _bleWriteSchema,
          result: PocketPluginSchema.object(
            properties: <String, PocketPluginSchema>{
              'ok': PocketPluginSchema.boolean(),
              'realBle': PocketPluginSchema.boolean(),
              'device': PocketPluginSchema.string(),
              'deviceId': PocketPluginSchema.string(),
              'serviceUuid': PocketPluginSchema.string(),
              'characteristicUuid': PocketPluginSchema.string(),
              'bytesWritten': PocketPluginSchema.integer(),
              'written': PocketPluginSchema.boolean(),
              'withResponse': PocketPluginSchema.boolean(),
            },
          ),
        ),
      ),
      HardwareCapabilities.bluetoothNotifications: PocketPluginCapability(
        name: HardwareCapabilities.bluetoothNotifications,
        kind: PocketCapabilityKind.stream,
        permissions: const <String>{HardwarePermissions.bluetooth},
        schema: PocketPluginCapabilitySchema(
          parameters: _bleSelectorSchema,
          streamItem: PocketPluginSchema.object(
            properties: <String, PocketPluginSchema>{
              'realBle': PocketPluginSchema.boolean(),
              'device': PocketPluginSchema.string(),
              'deviceId': PocketPluginSchema.string(),
              'serviceUuid': PocketPluginSchema.string(),
              'characteristicUuid': PocketPluginSchema.string(),
              'value': PocketPluginSchema.array(PocketPluginSchema.integer()),
              'timestampMs': PocketPluginSchema.integer(),
            },
          ),
        ),
      ),
      HardwareCapabilities.sensorsRead: PocketPluginCapability(
        name: HardwareCapabilities.sensorsRead,
        kind: PocketCapabilityKind.request,
        permissions: const <String>{HardwarePermissions.sensors},
      ),
      HardwareCapabilities.sensorsWatch: PocketPluginCapability(
        name: HardwareCapabilities.sensorsWatch,
        kind: PocketCapabilityKind.stream,
        permissions: const <String>{HardwarePermissions.sensors},
        schema: PocketPluginCapabilitySchema(
          parameters: _sensorWatchSchema,
          streamItem: PocketPluginSchema.object(
            properties: <String, PocketPluginSchema>{
              'realSensors': PocketPluginSchema.boolean(),
              'sensor': PocketPluginSchema.string(),
              'sensorType': PocketPluginSchema.integer(),
              'values': PocketPluginSchema.array(PocketPluginSchema.number()),
              'x': PocketPluginSchema.number(),
              'y': PocketPluginSchema.number(),
              'z': PocketPluginSchema.number(),
              'timestampNs': PocketPluginSchema.integer(),
              'accelX': PocketPluginSchema.number(),
              'accelY': PocketPluginSchema.number(),
              'accelZ': PocketPluginSchema.number(),
              'gravityX': PocketPluginSchema.number(),
              'gravityY': PocketPluginSchema.number(),
              'gravityZ': PocketPluginSchema.number(),
              'gyroX': PocketPluginSchema.number(),
              'gyroY': PocketPluginSchema.number(),
              'gyroZ': PocketPluginSchema.number(),
              'pitch': PocketPluginSchema.number(),
              'roll': PocketPluginSchema.number(),
              'yaw': PocketPluginSchema.number(),
              'pressureHpa': PocketPluginSchema.number(),
              'relativeAltitudeM': PocketPluginSchema.number(),
              'magneticX': PocketPluginSchema.number(),
              'magneticY': PocketPluginSchema.number(),
              'magneticZ': PocketPluginSchema.number(),
              'timestamp': PocketPluginSchema.string(),
            },
          ),
        ),
      ),
      HardwareCapabilities.biometricAuthenticate: PocketPluginCapability(
        name: HardwareCapabilities.biometricAuthenticate,
        kind: PocketCapabilityKind.request,
        permissions: const <String>{HardwarePermissions.biometrics},
      ),
      HardwareCapabilities.locationCurrent: PocketPluginCapability(
        name: HardwareCapabilities.locationCurrent,
        kind: PocketCapabilityKind.request,
        permissions: const <String>{HardwarePermissions.location},
      ),
      HardwareCapabilities.weatherCurrent: PocketPluginCapability(
        name: HardwareCapabilities.weatherCurrent,
        kind: PocketCapabilityKind.request,
        permissions: const <String>{HardwarePermissions.network},
        optionalPermissions: const <String>{HardwarePermissions.location},
      ),
    },
  );

  @override
  PocketPluginDescriptor get descriptor {
    final full = _fullDescriptor;
    final selectedPermissions = <String>{
      if (includeLegacyPermissions)
        ..._selectedOptionalPermissions(HardwarePermissions.all),
      for (final entry in full.capabilities.entries)
        if (_enabled(entry.key) &&
            entry.key != HardwareCapabilities.requestPermission)
          ...?entry.value.permissions,
      for (final entry in full.capabilities.entries)
        if (_enabled(entry.key) &&
            entry.key != HardwareCapabilities.requestPermission)
          ..._selectedOptionalPermissions(entry.value.optionalPermissions),
    };
    final capabilities = <String, PocketPluginCapability>{
      for (final entry in full.capabilities.entries)
        if (_enabled(entry.key))
          entry.key: entry.key == HardwareCapabilities.requestPermission
              ? PocketPluginCapability(
                  name: entry.key,
                  kind: entry.value.kind,
                  permissions: const {},
                  optionalPermissions: selectedPermissions,
                )
              : _selectedCapability(entry.value),
    };
    return PocketPluginDescriptor(
      id: pluginId,
      version: full.version,
      description: 'Selected PocketJS hardware capabilities',
      limits: full.limits,
      optionalPermissions: selectedPermissions,
      capabilities: capabilities,
    );
  }

  Set<String> _selectedOptionalPermissions(Set<String> permissions) =>
      Set<String>.unmodifiable(
        permissions.where(
          (permission) =>
              permission != HardwarePermissions.location ||
              features.contains(HardwareFeature.location),
        ),
      );

  PocketPluginCapability _selectedCapability(
    PocketPluginCapability capability,
  ) {
    final optionalPermissions = _selectedOptionalPermissions(
      capability.optionalPermissions,
    );
    if (optionalPermissions.length == capability.optionalPermissions.length) {
      return capability;
    }
    return PocketPluginCapability(
      name: capability.name,
      kind: capability.kind,
      description: capability.description,
      permissions: capability.permissions,
      optionalPermissions: optionalPermissions,
      schema: capability.schema,
    );
  }

  bool _enabled(String capability) {
    if (capability == HardwareCapabilities.permissions ||
        capability == HardwareCapabilities.requestPermission) {
      return includeLegacyPermissions;
    }
    return features.any(
      (feature) => HardwareFeatures.capabilities(feature).contains(capability),
    );
  }

  @override
  void register(PocketPluginContext context) {
    _activeContext = context;
    _trustedSessionId = _sessionIdentity(context);
    void registerRequest(String name, PocketCapabilityRequest handler) {
      if (_enabled(name)) context.registerRequest(name, handler);
    }

    void registerStream(String name, PocketCapabilityStream handler) {
      if (_enabled(name)) context.registerStream(name, handler);
    }

    registerRequest(
      HardwareCapabilities.permissions,
      (_) => _permissionSnapshot(),
    );
    registerRequest(HardwareCapabilities.requestPermission, (params) {
      final permission = _string(params, 'permission');
      _validatePermission(permission);
      _checkPermission(permission);
      return _systemPermission(permission, request: true);
    });
    registerRequest(HardwareCapabilities.cameraPreviewStart, (params) {
      _checkPermission(HardwarePermissions.camera);
      return _startPreview(params);
    });
    registerRequest(HardwareCapabilities.cameraPreviewStop, (_) {
      _checkPermission(HardwarePermissions.camera);
      return _stopPreview();
    });
    registerRequest(HardwareCapabilities.cameraLensSwitch, (params) {
      _checkPermission(HardwarePermissions.camera);
      return _switchCameraLens(params);
    });
    registerRequest(HardwareCapabilities.cameraFlashToggle, (params) {
      _checkPermission(HardwarePermissions.camera);
      final mode = params['flash'];
      if (mode != null) _validateFlash(mode);
      return _native(
        'toggleCameraFlash',
        params: <String, dynamic>{if (mode != null) 'flash': mode},
      );
    });
    registerRequest(HardwareCapabilities.cameraCapture, (params) {
      _checkPermission(HardwarePermissions.camera);
      return _native('capturePhoto', params: params);
    });
    registerRequest(HardwareCapabilities.photosList, (_) {
      _checkPermission(HardwarePermissions.photos);
      return _native('listSavedPhotos');
    });
    registerRequest(HardwareCapabilities.photosDelete, (params) {
      _checkPermission(HardwarePermissions.photos);
      final path = _string(params, 'filePath');
      if (path.trim().isEmpty) {
        throw const PocketCapabilityException(
          'invalid_argument',
          'filePath must not be empty',
        );
      }
      return _native(
        'deleteSavedPhoto',
        params: <String, dynamic>{'filePath': path},
      );
    });
    registerRequest(HardwareCapabilities.bluetoothScan, (params) {
      _checkPermission(HardwarePermissions.bluetooth);
      final timeoutMs = _boundedInt(
        params['timeoutMs'],
        field: 'timeoutMs',
        fallback: 1600,
        min: 250,
        max: 30000,
      );
      return _native(
        'startBleScan',
        params: <String, dynamic>{
          'timeoutMs': timeoutMs,
          ..._trustedSessionArguments(),
        },
        timeout: Duration(milliseconds: timeoutMs + 3000),
      );
    });
    registerRequest(HardwareCapabilities.bluetoothConnect, (params) {
      _checkPermission(HardwarePermissions.bluetooth);
      final deviceId = _string(params, 'deviceId');
      if (deviceId.trim().isEmpty) {
        throw const PocketCapabilityException(
          'invalid_argument',
          'deviceId must not be empty',
        );
      }
      return _native(
        'connectBleDevice',
        params: <String, dynamic>{
          'deviceId': deviceId,
          ..._trustedSessionArguments(),
        },
        timeout: const Duration(seconds: 15),
      );
    });
    registerRequest(HardwareCapabilities.bluetoothRead, (params) {
      _checkPermission(HardwarePermissions.bluetooth);
      return _native(
        'readBleCharacteristic',
        params: _bleRequestArguments(params, includeWithResponse: false),
        timeout: const Duration(seconds: 10),
      );
    });
    registerRequest(HardwareCapabilities.bluetoothWrite, (params) {
      _checkPermission(HardwarePermissions.bluetooth);
      return _native(
        'writeBleCharacteristic',
        params: _bleRequestArguments(params, requireValue: true),
        timeout: const Duration(seconds: 10),
      );
    });
    registerStream(HardwareCapabilities.bluetoothNotifications, (remote) {
      _checkPermission(HardwarePermissions.bluetooth);
      return _openHardwareStream(
        remote,
        kind: 'ble.notifications',
        params: _bleRequestArguments(remote.params, includeWithResponse: false),
      );
    });
    registerRequest(HardwareCapabilities.sensorsRead, (_) {
      _checkPermission(HardwarePermissions.sensors);
      final operation = _nextSensorOperation();
      return _native(
        'readSensors',
        params: <String, dynamic>{
          ...operation.toNativeArguments(),
          ..._trustedSessionArguments(),
          'timeoutMs': requestTimeout.inMilliseconds,
        },
        timeout: requestTimeout,
        onTimeout: () => _cancelSensorOperation(operation),
      );
    });
    registerStream(HardwareCapabilities.sensorsWatch, (remote) {
      _checkPermission(HardwarePermissions.sensors);
      return _openHardwareStream(
        remote,
        kind: 'sensors',
        params: <String, dynamic>{
          'samplingHz': _boundedInt(
            remote.params['samplingHz'],
            field: 'samplingHz',
            fallback: 10,
            min: 1,
            max: 60,
          ),
        },
      );
    });
    registerRequest(HardwareCapabilities.biometricAuthenticate, (params) {
      _checkPermission(HardwarePermissions.biometrics);
      final reason = params['reason'] == null
          ? 'Authenticate to continue'
          : _string(params, 'reason');
      if (reason.trim().isEmpty) {
        throw const PocketCapabilityException(
          'invalid_argument',
          'biometric reason must not be empty',
        );
      }
      return _native(
        'authenticateBiometrics',
        params: <String, dynamic>{
          'reason': reason,
          ..._trustedSessionArguments(),
        },
        timeout: const Duration(seconds: 30),
      );
    });
    registerRequest(HardwareCapabilities.locationCurrent, (_) {
      _checkPermission(HardwarePermissions.location);
      return _native(
        'getCurrentLocation',
        params: _trustedSessionArguments(),
        timeout: const Duration(seconds: 30),
      );
    });
    registerRequest(HardwareCapabilities.weatherCurrent, (params) {
      _checkPermission(HardwarePermissions.network);
      return _weather(params);
    });
  }

  @override
  FutureOr<void> activate(PocketPluginContext context) {
    _activeContext = context;
    _trustedSessionId = _sessionIdentity(context);
  }

  @override
  Future<void> deactivate(PocketPluginContext context) async {
    await _stopAllHardwareStreams();
    _activeContext = null;
    await _stopPreviewBestEffort();
    await _disposeNativeSessionBestEffort();
    _trustedSessionId = null;
    _stopped = true;
  }

  @override
  Future<void> dispose() async {
    await _stopAllHardwareStreams();
    _activeContext = null;
    await _stopPreviewBestEffort();
    await _disposeNativeSessionBestEffort();
    _trustedSessionId = null;
    _stopped = true;
  }

  Future<Map<String, dynamic>> _startPreview(
    Map<String, dynamic> params,
  ) async {
    final operationEpoch = ++_previewEpoch;
    return _serializeCamera(() async {
      final lens = params['lens'] ?? 'back';
      _validateLens(lens);
      final result = await _native(
        'startCameraPreview',
        params: <String, dynamic>{'lens': lens},
        timeout: requestTimeout,
      );
      final textureId = _intFrom(result['textureId']);
      final width = _intFrom(result['width']);
      final height = _intFrom(result['height']);
      if (textureId == null ||
          textureId < 0 ||
          width == null ||
          width <= 0 ||
          height == null ||
          height <= 0) {
        throw const PocketCapabilityException(
          'hardware_invalid_response',
          'camera preview did not return textureId, width and height',
        );
      }
      if (operationEpoch != _previewEpoch) {
        // A deactivation/stop overtook this native call.  The native manager
        // may have created a session after the stop, so clean it up while the
        // camera operation tail still excludes a newer start.
        await _native('stopCameraPreview', timeout: requestTimeout);
        throw const PocketCapabilityException(
          'plugin_revoked',
          'camera preview request completed after deactivation',
        );
      }
      _stopped = false;
      _registerTexture(textureId);
      return <String, dynamic>{
        ...result,
        'textureId': textureId,
        'surfaceId': textureId,
        'width': width,
        'height': height,
      };
    });
  }

  Future<Map<String, dynamic>> _switchCameraLens(
    Map<String, dynamic> params,
  ) async {
    final lens = params['lens'];
    if (lens != null) _validateLens(lens);
    if (_stopped) {
      return <String, dynamic>{'stopped': true, 'lens': lens ?? 'back'};
    }
    final epoch = ++_previewEpoch;
    return _serializeCamera(() async {
      if (_stopped || epoch != _previewEpoch) {
        return <String, dynamic>{'stopped': true, 'lens': lens ?? 'back'};
      }
      final result = await _native(
        'switchCameraLens',
        params: <String, dynamic>{if (lens != null) 'lens': lens},
        timeout: requestTimeout,
      );
      final surfaceId = _intFrom(result['surfaceId'] ?? result['textureId']);
      if (_stopped || epoch != _previewEpoch) {
        if (surfaceId != null && onTextureReleased != null) {
          onTextureReleased?.call(surfaceId);
        }
        await _native('stopCameraPreview', timeout: requestTimeout);
        return <String, dynamic>{'stopped': true, 'lens': lens ?? 'back'};
      }
      if (surfaceId != null) {
        _registerTexture(surfaceId);
      }
      return result;
    });
  }

  Future<Map<String, dynamic>> _stopPreview() async {
    ++_previewEpoch;
    return _serializeCamera(() async {
      try {
        final result = await _native(
          'stopCameraPreview',
          timeout: requestTimeout,
        );
        _releaseTexture();
        _stopped = true;
        return result;
      } catch (_) {
        // If the native process has already gone away, its texture cannot be
        // used by the new guest either.  Remove the renderer surface locally.
        _releaseTexture();
        _stopped = true;
        rethrow;
      }
    });
  }

  Future<void> _stopPreviewBestEffort() async {
    ++_previewEpoch;
    if (_textureId == null && _stopped) return;
    try {
      await _stopPreview();
    } catch (_) {
      // Deactivation must not mask a guest cutover.  The native implementation
      // is idempotent, and the texture callback has already been revoked.
    }
  }

  Future<void> _disposeNativeSessionBestEffort() async {
    try {
      await _native(
        'disposeSession',
        params: <String, dynamic>{
          ..._trustedSessionArguments(),
          'sensorOwnerToken': _sensorOwnerToken,
        },
        timeout: requestTimeout,
      );
    } catch (_) {
      // The provider can already be gone during a host cutover.  The native
      // side still receives this call whenever its channel is alive, while a
      // failed cleanup must not prevent the next guest from mounting.
    }
  }

  String _sessionIdentity(PocketPluginContext context) =>
      '${context.appId}:${context.sessionId}${pluginId == hardwarePluginId ? '' : ':$pluginId'}';

  Map<String, dynamic> _trustedSessionArguments() {
    final sessionId = _trustedSessionId;
    if (sessionId == null || sessionId.isEmpty) {
      throw const PocketCapabilityException(
        'plugin_revoked',
        'hardware plugin has no active trusted session',
      );
    }
    return <String, dynamic>{'sessionId': sessionId};
  }

  Map<String, dynamic> _bleRequestArguments(
    Map<String, dynamic> params, {
    bool requireValue = false,
    bool includeWithResponse = true,
  }) {
    final deviceId = _string(params, 'deviceId');
    final serviceUuid = _string(params, 'serviceUuid');
    final characteristicUuid = _string(params, 'characteristicUuid');
    if (deviceId.trim().isEmpty ||
        serviceUuid.trim().isEmpty ||
        characteristicUuid.trim().isEmpty) {
      throw const PocketCapabilityException(
        'invalid_argument',
        'deviceId, serviceUuid, and characteristicUuid must not be empty',
      );
    }
    final result = <String, dynamic>{
      'deviceId': deviceId,
      'serviceUuid': serviceUuid,
      'characteristicUuid': characteristicUuid,
      ..._trustedSessionArguments(),
    };
    if (includeWithResponse) {
      final withResponse = params['withResponse'];
      if (withResponse != null && withResponse is! bool) {
        throw const PocketCapabilityException(
          'invalid_argument',
          'withResponse must be a boolean',
        );
      }
      result['withResponse'] = withResponse ?? true;
    }
    if (requireValue) {
      final value = params['value'];
      if (value is! List || value.any((item) => item is! num || item is bool)) {
        throw const PocketCapabilityException(
          'invalid_argument',
          'value must be an array of bytes',
        );
      }
      final bytes = <int>[];
      for (final item in value) {
        final number = (item as num);
        if (!number.isFinite || number % 1 != 0 || number < 0 || number > 255) {
          throw const PocketCapabilityException(
            'invalid_argument',
            'value bytes must be integers between 0 and 255',
          );
        }
        bytes.add(number.toInt());
      }
      if (bytes.length > 512) {
        throw const PocketCapabilityException(
          'invalid_argument',
          'value must not exceed 512 bytes',
        );
      }
      result['value'] = bytes;
    }
    return result;
  }

  Stream<Object?> _openHardwareStream(
    PocketHostStreamContext remote, {
    required String kind,
    required Map<String, dynamic> params,
  }) {
    final streamingPlatform = _platform is HardwareStreamingPlatform
        ? _platform as HardwareStreamingPlatform
        : null;
    if (streamingPlatform == null) {
      return Stream<Object?>.error(
        const PocketCapabilityException(
          'hardware_streaming_unsupported',
          'native hardware event streaming is unavailable',
        ),
      );
    }
    final guestStreamId = remote.streamId;
    final trustedSessionId = _trustedSessionId;
    if (trustedSessionId == null || trustedSessionId.isEmpty) {
      return Stream<Object?>.error(
        const PocketCapabilityException(
          'plugin_revoked',
          'hardware plugin has no active trusted session',
        ),
      );
    }
    // Native stream ids are never guest-controlled bare ids. Prefixing with
    // both the provider and trusted host session prevents a stale stream from
    // one guest/session from colliding with a later stream on the process-wide
    // EventChannel. The guest still sees only its own original stream id via
    // PocketHost's stream bridge.
    final streamId = '$pluginId:$trustedSessionId:$guestStreamId';
    final existing = _activeHardwareStreams[streamId];
    if (existing != null) {
      return Stream<Object?>.error(
        const PocketCapabilityException(
          'hardware_stream_exists',
          'hardware stream id is already active',
        ),
      );
    }

    late final _HardwareStreamBinding binding;
    final controller = StreamController<Object?>(sync: true);
    var cleaned = false;
    Future<void> stop({bool closeController = true}) async {
      if (cleaned) return;
      cleaned = true;
      _activeHardwareStreams.remove(streamId);
      await binding.eventsSubscription?.cancel();
      binding.eventsSubscription = null;
      try {
        await streamingPlatform.stopHardwareStream(<String, dynamic>{
          'streamId': streamId,
          'kind': kind,
          ..._trustedSessionArguments(),
        });
      } catch (_) {
        // The stream is already being torn down. Native cleanup is best effort
        // after a revoked MethodChannel or an already-disconnected device.
      }
      if (closeController && !controller.isClosed) {
        await controller.close();
      }
    }

    binding = _HardwareStreamBinding(streamId, controller, stop);
    _activeHardwareStreams[streamId] = binding;
    controller.onListen = () {
      if (cleaned || _activeContext == null || _activeContext!.isRevoked) {
        controller.addError(
          const PocketCapabilityException(
            'plugin_revoked',
            'hardware plugin is revoked',
          ),
        );
        unawaited(stop());
        return;
      }
      // Subscribe before asking native to start. Native may emit its first
      // sample immediately after start; the platform implementation also
      // bounds packets while the EventChannel sink is attaching.
      binding.eventsSubscription = streamingPlatform.hardwareEvents.listen(
        (event) {
          if (cleaned || event is! Map) return;
          final packet = Map<String, dynamic>.from(event);
          if ('${packet['streamId'] ?? ''}' != streamId) return;
          final errorValue = packet['error'];
          if (errorValue != null) {
            final errorMap = errorValue is Map
                ? Map<String, dynamic>.from(errorValue)
                : <String, dynamic>{'message': '$errorValue'};
            controller.addError(
              PocketCapabilityException(
                '${errorMap['code'] ?? 'hardware_stream_error'}',
                '${errorMap['message'] ?? 'hardware stream failed'}',
              ),
            );
            unawaited(stop());
            return;
          }
          if (packet['done'] == true) {
            unawaited(stop());
            return;
          }
          if (packet.containsKey('data') && !controller.isClosed) {
            controller.add(packet['data']);
          }
        },
        onError: (Object error, StackTrace stack) {
          if (cleaned || controller.isClosed) return;
          controller.addError(_asStreamException(error), stack);
          unawaited(stop());
        },
        onDone: () {
          if (cleaned) return;
          unawaited(stop());
        },
      );
      final startArguments = <String, dynamic>{
        ...params,
        'kind': kind,
        'streamId': streamId,
        ..._trustedSessionArguments(),
      };
      binding.startFuture = streamingPlatform
          .startHardwareStream(startArguments)
          .then(
            (response) {
              if (response['ok'] == false && !controller.isClosed) {
                controller.addError(
                  PocketCapabilityException(
                    '${response['errorCode'] ?? response['code'] ?? 'hardware_stream_error'}',
                    '${response['error'] ?? response['message'] ?? 'hardware stream failed'}',
                  ),
                );
                unawaited(stop());
              }
            },
            onError: (Object error, StackTrace stack) {
              if (!controller.isClosed) {
                controller.addError(_asStreamException(error), stack);
              }
              unawaited(stop());
            },
          );
    };
    controller.onCancel = () => stop();
    return controller.stream;
  }

  Object _asStreamException(Object error) => error is HardwarePlatformException
      ? PocketCapabilityException(error.code, error.message)
      : error;

  Future<void> _stopAllHardwareStreams() async {
    final active = _activeHardwareStreams.values.toList(growable: false);
    for (final binding in active) {
      await binding.stop();
    }
  }

  Future<T> _serializeCamera<T>(Future<T> Function() operation) {
    final completion = Completer<T>();
    final previous = _cameraTail;
    final run = previous.then<void>((_) async {
      try {
        completion.complete(await operation());
      } catch (error, stack) {
        completion.completeError(error, stack);
      }
    });
    _cameraTail = run.then<void>((_) {}, onError: (_, __) {});
    return completion.future;
  }

  void _registerTexture(int textureId) {
    final previous = _textureId;
    _textureId = textureId;
    if (previous != null && previous != textureId) {
      onTextureReleased?.call(previous);
    }
    if (previous != textureId) {
      onTextureRegistered?.call(textureId);
    }
  }

  void _releaseTexture() {
    final textureId = _textureId;
    _textureId = null;
    if (textureId != null) onTextureReleased?.call(textureId);
  }

  _SensorOperationIdentity _nextSensorOperation() =>
      _SensorOperationIdentity(_sensorOwnerToken, ++_sensorOperationEpoch);

  Future<void> _cancelSensorOperation(
    _SensorOperationIdentity operation,
  ) async {
    try {
      await _platform
          .invoke('cancelSensorOperation', operation.toNativeArguments())
          .timeout(const Duration(seconds: 2));
    } catch (_) {
      // Best-effort native cleanup when the caller times out early.
    }
  }

  Future<Map<String, dynamic>> _native(
    String method, {
    Map<String, dynamic> params = const <String, dynamic>{},
    Duration? timeout,
    FutureOr<void> Function()? onTimeout,
  }) async {
    try {
      final result = await _platform
          .invoke(method, params)
          .timeout(timeout ?? requestTimeout);
      final ok = result['ok'];
      if (ok == false) {
        throw PocketCapabilityException(
          '${result['errorCode'] ?? result['code'] ?? 'hardware_error'}',
          '${result['error'] ?? result['message'] ?? 'hardware request failed'}',
        );
      }
      return result;
    } on PocketCapabilityException {
      rethrow;
    } on HardwarePlatformException catch (error) {
      throw PocketCapabilityException(error.code, error.message);
    } on TimeoutException {
      if (onTimeout != null) {
        unawaited(Future<void>.sync(onTimeout).catchError((_) {}));
      }
      throw const PocketCapabilityException(
        'hardware_timeout',
        'hardware request timed out',
      );
    } on Object catch (error) {
      throw PocketCapabilityException('hardware_provider_error', '$error');
    }
  }

  Future<Map<String, dynamic>> _weather(Map<String, dynamic> params) async {
    _checkPermission(HardwarePermissions.network);
    final suppliedLatitude = params['latitude'];
    final suppliedLongitude = params['longitude'];
    if ((suppliedLatitude == null) != (suppliedLongitude == null)) {
      throw const PocketCapabilityException(
        'invalid_argument',
        'latitude and longitude must be supplied together',
      );
    }

    late final double latitude;
    late final double longitude;
    var realGps = false;
    if (suppliedLatitude == null || suppliedLongitude == null) {
      if (!features.contains(HardwareFeature.location)) {
        throw const PocketCapabilityException(
          'invalid_argument',
          'latitude and longitude are required when the location provider is not selected',
        );
      }
      _checkPermission(HardwarePermissions.location);
      final location = await _native(
        'getCurrentLocation',
        params: <String, dynamic>{
          ..._trustedSessionArguments(),
          if (params['accuracy'] != null) 'accuracy': params['accuracy'],
        },
        timeout: const Duration(seconds: 30),
      );
      latitude = _finiteNumber(location['latitude'], 'latitude');
      longitude = _finiteNumber(location['longitude'], 'longitude');
      realGps = location['realGps'] == true;
    } else {
      latitude = _finiteNumber(suppliedLatitude, 'latitude');
      longitude = _finiteNumber(suppliedLongitude, 'longitude');
    }
    if (latitude < -90 ||
        latitude > 90 ||
        longitude < -180 ||
        longitude > 180) {
      throw const PocketCapabilityException(
        'invalid_argument',
        'coordinates are outside the valid range',
      );
    }
    final uri = Uri.https('api.open-meteo.com', '/v1/forecast', <
      String,
      String
    >{
      'latitude': '$latitude',
      'longitude': '$longitude',
      'current':
          'temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,surface_pressure,wind_speed_10m,wind_direction_10m',
      'hourly': 'temperature_2m',
      'daily':
          'weather_code,temperature_2m_max,temperature_2m_min,uv_index_max,precipitation_probability_max',
      'forecast_days': '7',
      'timezone': 'auto',
    });
    final response = await _invokeWeather(uri);
    return <String, dynamic>{
      'ok': true,
      'provider': pluginId,
      'source': 'open-meteo',
      'realGps': realGps,
      'realNetwork': true,
      'latitude': latitude,
      'longitude': longitude,
      ...response,
    };
  }

  Future<Map<String, dynamic>> _invokeWeather(Uri uri) async {
    try {
      return await _weatherFetcher(uri).timeout(const Duration(seconds: 20));
    } on PocketCapabilityException {
      rethrow;
    } on TimeoutException {
      throw const PocketCapabilityException(
        'hardware_weather_timeout',
        'weather request timed out',
      );
    } on Object catch (error) {
      throw PocketCapabilityException(
        'hardware_weather_network',
        'weather request failed: $error',
      );
    }
  }

  static Future<Map<String, dynamic>> _fetchOpenMeteo(Uri uri) async {
    final client = HttpClient();
    try {
      final request = await client.getUrl(uri);
      final response = await request.close();
      final body = await utf8.decoder.bind(response).join();
      if (response.statusCode < 200 || response.statusCode >= 300) {
        throw PocketCapabilityException(
          'hardware_weather_http',
          'weather service returned HTTP ${response.statusCode}',
        );
      }
      final decoded = jsonDecode(body);
      if (decoded is! Map) {
        throw const PocketCapabilityException(
          'hardware_weather_invalid_response',
          'weather service returned a non-object response',
        );
      }
      return Map<String, dynamic>.from(decoded);
    } on PocketCapabilityException {
      rethrow;
    } on FormatException {
      throw const PocketCapabilityException(
        'hardware_weather_invalid_response',
        'weather service returned invalid JSON',
      );
    } finally {
      client.close(force: true);
    }
  }

  static String _string(Map<String, dynamic> params, String key) {
    final value = params[key];
    if (value is! String) {
      throw PocketCapabilityException(
        'invalid_argument',
        '$key must be a string',
      );
    }
    return value;
  }

  static int _boundedInt(
    Object? value, {
    required String field,
    required int fallback,
    required int min,
    required int max,
  }) {
    if (value == null) return fallback;
    if (value is! num || !value.isFinite || value % 1 != 0) {
      throw PocketCapabilityException(
        'invalid_argument',
        '$field must be an integer',
      );
    }
    final result = value.toInt();
    if (result < min || result > max) {
      throw PocketCapabilityException(
        'invalid_argument',
        '$field must be between $min and $max',
      );
    }
    return result;
  }

  static double _finiteNumber(Object? value, String field) {
    if (value is! num || !value.isFinite) {
      throw PocketCapabilityException(
        'hardware_invalid_response',
        '$field is not a finite number',
      );
    }
    return value.toDouble();
  }

  static int? _intFrom(Object? value) =>
      value is num && value.isFinite ? value.toInt() : null;

  static void _validateLens(Object? value) {
    if (value != 'front' && value != 'back') {
      throw const PocketCapabilityException(
        'invalid_argument',
        'lens must be front or back',
      );
    }
  }

  static void _validateFlash(Object? value) {
    if (value != 'on' && value != 'off' && value != 'auto') {
      throw const PocketCapabilityException(
        'invalid_argument',
        'flash must be on, off or auto',
      );
    }
  }

  Future<Map<String, dynamic>> _permissionSnapshot() async {
    final permissions = <String, dynamic>{};
    for (final permission in descriptor.optionalPermissions) {
      final value = await _systemPermission(permission, request: false);
      permissions[_nativePermission(permission)] = value;
    }
    return <String, dynamic>{'ok': true, 'permissions': permissions};
  }

  Future<Map<String, dynamic>> _systemPermission(
    String permission, {
    required bool request,
  }) async {
    // These policy grants do not correspond to an OS permission dialog.
    // Biometric capability and enrollment are checked by authenticateBiometrics.
    if (permission == HardwarePermissions.biometrics ||
        permission == HardwarePermissions.network) {
      return <String, dynamic>{
        'ok': true,
        'permission': _nativePermission(permission),
        'status': 'notRequired',
        'granted': true,
        'runtimePermissionRequired': false,
      };
    }
    final handler = _permissionHandler;
    if (handler == null) {
      throw const PocketCapabilityException(
        'permissions_unconfigured',
        'Register pocket_permissions to request operating-system permissions',
      );
    }
    final result = await handler(permission, request: request);
    return <String, dynamic>{
      ...result,
      'permission': _nativePermission(permission),
    };
  }

  static void _validatePermission(String value) {
    if (!HardwarePermissions.all.contains(value)) {
      throw const PocketCapabilityException(
        'invalid_argument',
        'unsupported hardware permission',
      );
    }
  }

  static String _nativePermission(String permission) => switch (permission) {
    HardwarePermissions.camera => 'camera',
    HardwarePermissions.photos => 'photos',
    HardwarePermissions.bluetooth => 'bluetooth',
    HardwarePermissions.sensors => 'sensors',
    HardwarePermissions.biometrics => 'biometrics',
    HardwarePermissions.location => 'location',
    HardwarePermissions.microphone => 'microphone',
    HardwarePermissions.network => 'network',
    _ => permission,
  };
}
