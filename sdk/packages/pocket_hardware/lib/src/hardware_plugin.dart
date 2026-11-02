import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/services.dart';
import 'package:pocket_services/pocket_services.dart';

/// The compiled-in iOS and Android hardware provider.  A guest can only reach these
/// methods through the signed capability/permission negotiation; no guest
/// package can provide or load native code.
const String hardwarePluginId = 'flutter.hardware';
const String hardwareMethodChannelName = 'com.pocketnexus.host/hardware';

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
  static const String sensorsRead = 'hardware.sensors.read';
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
    sensorsRead,
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

final class HardwarePlatformException implements Exception {
  const HardwarePlatformException(this.code, this.message);

  final String code;
  final String message;

  @override
  String toString() => 'HardwarePlatformException($code): $message';
}

final class MethodChannelHardwarePlatform implements HardwarePlatform {
  MethodChannelHardwarePlatform({MethodChannel? channel})
      : channel = channel ?? const MethodChannel(hardwareMethodChannelName);

  final MethodChannel channel;

  @override
  Future<Map<String, dynamic>> invoke(
    String method, [
    Map<String, dynamic> arguments = const <String, dynamic>{},
  ]) async {
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

typedef HardwareWeatherFetcher = Future<Map<String, dynamic>> Function(Uri uri);

/// The network side of weather remains a host-owned service.  It consumes a
/// real location (or explicit caller coordinates) and never supplies seeded or
/// simulated values when platform/network support is missing.
final class HardwarePlugin extends PocketPlugin {
  HardwarePlugin({
    HardwarePlatform? platform,
    HardwareWeatherFetcher? weatherFetcher,
    this.onTextureRegistered,
    this.onTextureReleased,
    this.requestTimeout = const Duration(seconds: 12),
    Set<String>? grantedPermissions,
  })  : _platform = platform ?? MethodChannelHardwarePlatform(),
        _weatherFetcher = weatherFetcher ?? _fetchOpenMeteo,
        _grantedPermissions = grantedPermissions;

  final HardwarePlatform _platform;
  final HardwareWeatherFetcher _weatherFetcher;
  final HardwareTextureCallback? onTextureRegistered;
  final HardwareTextureCallback? onTextureReleased;
  final Duration requestTimeout;
  final Set<String>? _grantedPermissions;
  int? _textureId;
  bool _stopped = true;
  int _previewEpoch = 0;
  Future<void> _cameraTail = Future<void>.value();
  PocketPluginContext? _activeContext;

  void _checkPermission(String permission) {
    if (_grantedPermissions != null && !_grantedPermissions.contains(permission)) {
      throw PocketCapabilityException(
        'permission_denied',
        'permission $permission is not granted',
      );
    }
    if (_activeContext != null && !_activeContext!.grantedPermissions.contains(permission)) {
      throw PocketCapabilityException(
        'permission_denied',
        'permission $permission is not granted',
      );
    }
  }

  @override
  PocketPluginDescriptor get descriptor => const PocketPluginDescriptor(
        id: hardwarePluginId,
        version: '1.0.0',
        description:
            'Compiled host camera, photos, BLE, sensors, biometrics, location and weather provider',
        permissions: const <String>{},
        optionalPermissions: HardwarePermissions.all,
        limits: PocketPluginLimits(
          maxConcurrentRequests: 4,
          maxResponseBytes: 512 * 1024,
          maxStreamEvents: 256,
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
          HardwareCapabilities.sensorsRead: PocketPluginCapability(
            name: HardwareCapabilities.sensorsRead,
            kind: PocketCapabilityKind.request,
            permissions: const <String>{HardwarePermissions.sensors},
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
  void register(PocketPluginContext context) {
    _activeContext = context;
    context.registerRequest(HardwareCapabilities.permissions, (_) {
      return _native('checkPermissions');
    });
    context.registerRequest(HardwareCapabilities.requestPermission, (params) {
      final permission = _string(params, 'permission');
      _validatePermission(permission);
      _checkPermission(permission);
      return _native(
        'requestPermission',
        params: <String, dynamic>{'permission': _nativePermission(permission)},
      );
    });
    context.registerRequest(HardwareCapabilities.cameraPreviewStart, (params) {
      _checkPermission(HardwarePermissions.camera);
      return _startPreview(params);
    });
    context.registerRequest(HardwareCapabilities.cameraPreviewStop, (_) {
      _checkPermission(HardwarePermissions.camera);
      return _stopPreview();
    });
    context.registerRequest(HardwareCapabilities.cameraLensSwitch, (params) {
      _checkPermission(HardwarePermissions.camera);
      return _switchCameraLens(params);
    });
    context.registerRequest(HardwareCapabilities.cameraFlashToggle, (params) {
      _checkPermission(HardwarePermissions.camera);
      final mode = params['flash'];
      if (mode != null) _validateFlash(mode);
      return _native(
        'toggleCameraFlash',
        params: <String, dynamic>{if (mode != null) 'flash': mode},
      );
    });
    context.registerRequest(HardwareCapabilities.cameraCapture, (params) {
      _checkPermission(HardwarePermissions.camera);
      return _native('capturePhoto', params: params);
    });
    context.registerRequest(HardwareCapabilities.photosList, (_) {
      _checkPermission(HardwarePermissions.photos);
      return _native('listSavedPhotos');
    });
    context.registerRequest(HardwareCapabilities.photosDelete, (params) {
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
    context.registerRequest(HardwareCapabilities.bluetoothScan, (params) {
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
        params: <String, dynamic>{'timeoutMs': timeoutMs},
        timeout: Duration(milliseconds: timeoutMs + 3000),
      );
    });
    context.registerRequest(HardwareCapabilities.bluetoothConnect, (params) {
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
        params: <String, dynamic>{'deviceId': deviceId},
        timeout: const Duration(seconds: 15),
      );
    });
    context.registerRequest(HardwareCapabilities.sensorsRead, (_) {
      _checkPermission(HardwarePermissions.sensors);
      return _native('readSensors', timeout: const Duration(seconds: 3));
    });
    context.registerRequest(HardwareCapabilities.biometricAuthenticate, (
      params,
    ) {
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
        params: <String, dynamic>{'reason': reason},
        timeout: const Duration(seconds: 30),
      );
    });
    context.registerRequest(HardwareCapabilities.locationCurrent, (_) {
      _checkPermission(HardwarePermissions.location);
      return _native(
        'getCurrentLocation',
        timeout: const Duration(seconds: 30),
      );
    });
    context.registerRequest(HardwareCapabilities.weatherCurrent, (params) {
      _checkPermission(HardwarePermissions.network);
      return _weather(params);
    });
  }

  @override
  FutureOr<void> activate(PocketPluginContext context) {
    _activeContext = context;
  }

  @override
  Future<void> deactivate(PocketPluginContext context) async {
    _activeContext = null;
    await _stopPreviewBestEffort();
    await _disposeNativeSessionBestEffort();
    _stopped = true;
  }

  @override
  Future<void> dispose() async {
    _activeContext = null;
    await _stopPreviewBestEffort();
    await _disposeNativeSessionBestEffort();
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
      return <String, dynamic>{
        'stopped': true,
        'lens': lens ?? 'back',
      };
    }
    final epoch = ++_previewEpoch;
    return _serializeCamera(() async {
      if (_stopped || epoch != _previewEpoch) {
        return <String, dynamic>{
          'stopped': true,
          'lens': lens ?? 'back',
        };
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
        return <String, dynamic>{
          'stopped': true,
          'lens': lens ?? 'back',
        };
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
      await _native('disposeSession', timeout: requestTimeout);
    } catch (_) {
      // The provider can already be gone during a host cutover.  The native
      // side still receives this call whenever its channel is alive, while a
      // failed cleanup must not prevent the next guest from mounting.
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

  Future<Map<String, dynamic>> _native(
    String method, {
    Map<String, dynamic> params = const <String, dynamic>{},
    Duration? timeout,
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
      _checkPermission(HardwarePermissions.location);
      final location = await _native(
        'getCurrentLocation',
        params: <String, dynamic>{
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
    final uri =
        Uri.https('api.open-meteo.com', '/v1/forecast', <String, String>{
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
      'provider': hardwarePluginId,
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
