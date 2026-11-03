import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:pocket_services/pocket_services.dart'
    show PocketCapabilityException;

export 'package:pocket_services/pocket_services.dart'
    show PocketCapabilityException;

/// Persistent, app-scoped JSON storage for the thin System host.
///
/// App routing, mailboxes and their policy live exclusively in the JS SystemUI.
///
/// Storage is kept in one host-owned JSON file below [directory]. Keeping a
/// single file is deliberate: app IDs, keys, and namespaces never become
/// filesystem path components, which removes an entire path traversal and
/// child-symlink class of bugs. Writes use a same-directory temporary file and
/// an atomic rename.
final class PocketPlatformData {
  PocketPlatformData({
    required Directory directory,
    this.maxValueBytes = 65536,
    this.maxAppBytes = 1048576,
  }) : _directory = directory.absolute {
    if (maxValueBytes < 0) {
      throw ArgumentError.value(
        maxValueBytes,
        'maxValueBytes',
        'must be non-negative',
      );
    }
    if (maxAppBytes < 0) {
      throw ArgumentError.value(
        maxAppBytes,
        'maxAppBytes',
        'must be non-negative',
      );
    }
  }

  static const int _formatVersion = 1;
  static const String _storeFileName = 'pocket_platform_data.json';
  static const String _temporarySuffix = '.tmp';
  static const int _maxIdentifierBytes = 256;

  final Directory _directory;
  final int maxValueBytes;
  final int maxAppBytes;

  final Map<String, _AppRegistration> _registrations =
      <String, _AppRegistration>{};
  final Map<String, Map<String, Object?>> _privateValues =
      <String, Map<String, Object?>>{};
  final Map<String, Map<String, Object?>> _sharedValues =
      <String, Map<String, Object?>>{};
  Future<void> _operationTail = Future<void>.value();
  Future<void>? _initializeFuture;
  bool _initialized = false;
  bool _closed = false;
  bool _closingRequested = false;

  /// Opens the host-owned store. Multiple concurrent calls share one future.
  Future<void> initialize() {
    if (_closed || _closingRequested) return Future<void>.error(_closedError);
    if (_initialized) return Future<void>.value();
    final pending = _initializeFuture;
    if (pending != null) return pending;

    final future = _enqueue<void>(() async {
      _ensureNotClosed();
      try {
        await _loadFromDisk();
        _ensureNotClosed();
        _initialized = true;
      } on PocketCapabilityException {
        rethrow;
      } on Object catch (error) {
        throw PocketCapabilityException(
          'storage_unavailable',
          'Unable to initialize platform storage: $error',
        );
      }
    });
    _initializeFuture = future;
    future.then<void>(
      (_) {
        if (identical(_initializeFuture, future)) _initializeFuture = null;
      },
      onError: (Object _, StackTrace __) {
        if (identical(_initializeFuture, future)) _initializeFuture = null;
      },
    );
    return future;
  }

  /// Registers a host-owned app and its explicit shared-area IO grants.
  ///
  /// Re-registering with the same ACLs is idempotent. Changing ACLs for an
  /// existing app is rejected so an old app instance cannot silently gain
  /// access when a caller accidentally reuses its ID.
  void registerApp(
    String appId, {
    Set<String> sharedNamespaces = const <String>{},
  }) {
    _ensureReadySync();
    _validateAppId(appId);
    final shared = _validatedSet(sharedNamespaces, 'namespace');
    final existing = _registrations[appId];
    if (existing != null) {
      if (!existing.sharedNamespaces.containsAll(shared) ||
          !shared.containsAll(existing.sharedNamespaces)) {
        throw const PocketCapabilityException(
          'registration_conflict',
          'App is already registered with different permissions',
        );
      }
      return;
    }
    _registrations[appId] = _AppRegistration(shared);
    _privateValues.putIfAbsent(appId, () => <String, Object?>{});
  }

  /// Reads a cloned JSON value. Missing keys and stored null both return null.
  Future<Object?> read(String appId, String key, {String? namespace}) {
    if (_closed || _closingRequested)
      return Future<Object?>.error(_closedError);
    return _enqueue<Object?>(() async {
      _ensureReady();
      final bucket = _bucketFor(appId, key, namespace);
      return _cloneJson(bucket[key]);
    });
  }

  /// Writes a JSON value after validating snapshots and both value/scope quota.
  Future<void> write(
    String appId,
    String key,
    Object? value, {
    String? namespace,
  }) {
    if (_closed || _closingRequested) return Future<void>.error(_closedError);
    return _enqueue<void>(() async {
      _ensureReady();
      final bucket = _bucketFor(appId, key, namespace);
      final snapshot = _snapshotJson(value);
      final valueBytes = _jsonBytes(snapshot);
      if (valueBytes > maxValueBytes) {
        throw PocketCapabilityException(
          'value_too_large',
          'Value for "$key" is $valueBytes bytes; limit is $maxValueBytes',
        );
      }

      final hadValue = bucket.containsKey(key);
      final oldValue = bucket[key];
      bucket[key] = snapshot;
      final newUsage = _bucketBytes(bucket);
      if (newUsage > maxAppBytes) {
        if (hadValue) {
          bucket[key] = oldValue;
        } else {
          bucket.remove(key);
        }
        throw PocketCapabilityException(
          'quota_exceeded',
          'Storage quota exceeded for ${_scopeDescription(appId, namespace)}',
        );
      }
      try {
        await _persist();
      } catch (error, stack) {
        if (hadValue) {
          bucket[key] = oldValue;
        } else {
          bucket.remove(key);
        }
        Error.throwWithStackTrace(error, stack);
      }
    });
  }

  /// Removes a value. Removing an absent key is an idempotent no-op.
  Future<void> remove(String appId, String key, {String? namespace}) {
    if (_closed || _closingRequested) return Future<void>.error(_closedError);
    return _enqueue<void>(() async {
      _ensureReady();
      final bucket = _bucketFor(appId, key, namespace);
      if (!bucket.containsKey(key)) return;
      final oldValue = bucket.remove(key);
      try {
        await _persist();
      } catch (error, stack) {
        bucket[key] = oldValue;
        Error.throwWithStackTrace(error, stack);
      }
    });
  }

  /// Lists keys visible to [appId] in sorted order.
  Future<List<String>> keys(String appId, {String? namespace}) {
    if (_closed || _closingRequested) {
      return Future<List<String>>.error(_closedError);
    }
    return _enqueue<List<String>>(() async {
      _ensureReady();
      final bucket = _bucketFor(appId, '', namespace, validateKey: false);
      return List<String>.from(bucket.keys)..sort();
    });
  }

  /// Closes after queued IO completes. Values remain on disk.
  Future<void> close() {
    if (_closed) return Future<void>.value();
    if (_closingRequested) return _operationTail;
    _closingRequested = true;
    return _enqueue<void>(() async {
      _closed = true;
      _initialized = false;
    });
  }

  Future<T> _enqueue<T>(Future<T> Function() operation) {
    final result = Completer<T>();

    Future<void> run() async {
      try {
        result.complete(await operation());
      } catch (error, stack) {
        result.completeError(error, stack);
      }
    }

    _operationTail = _operationTail.then<void>(
      (_) => run(),
      onError: (Object _, StackTrace __) => run(),
    );
    return result.future;
  }

  Future<void> _loadFromDisk() async {
    final type = await FileSystemEntity.type(
      _directory.path,
      followLinks: false,
    );
    if (type == FileSystemEntityType.notFound) {
      await _directory.create(recursive: true);
    } else if (type != FileSystemEntityType.directory) {
      throw const PocketCapabilityException(
        'storage_symlink',
        'Storage root must be a real directory',
      );
    }
    final finalType = await FileSystemEntity.type(
      _directory.path,
      followLinks: false,
    );
    if (finalType != FileSystemEntityType.directory) {
      throw const PocketCapabilityException(
        'storage_symlink',
        'Storage root must be a real directory',
      );
    }

    final file = _storeFile;
    final fileType = await FileSystemEntity.type(file.path, followLinks: false);
    if (fileType == FileSystemEntityType.link) {
      throw const PocketCapabilityException(
        'storage_symlink',
        'Platform data file must not be a symbolic link',
      );
    }
    if (fileType == FileSystemEntityType.notFound) {
      _privateValues.clear();
      _sharedValues.clear();
      await _persist();
      return;
    }
    if (fileType != FileSystemEntityType.file) {
      throw const PocketCapabilityException(
        'storage_unavailable',
        'Platform data file is not a regular file',
      );
    }

    final String content;
    try {
      content = await file.readAsString();
    } on Object catch (error) {
      throw PocketCapabilityException(
        'storage_unavailable',
        'Unable to read platform data: $error',
      );
    }
    final Object? decoded;
    try {
      decoded = jsonDecode(content);
    } on Object catch (error) {
      throw PocketCapabilityException(
        'storage_corrupt',
        'Platform data is not valid JSON: $error',
      );
    }
    if (decoded is! Map) {
      throw const PocketCapabilityException(
        'storage_corrupt',
        'Platform data root must be a JSON object',
      );
    }
    final version = decoded['version'];
    if (version != _formatVersion) {
      throw PocketCapabilityException(
        'storage_corrupt',
        'Unsupported platform data version: $version',
      );
    }
    final private = decoded['private'];
    final shared = decoded['shared'];
    if (private is! Map || shared is! Map) {
      throw const PocketCapabilityException(
        'storage_corrupt',
        'Platform data must contain private and shared objects',
      );
    }

    final restoredPrivate = _decodeScopeMap(private, isNamespace: false);
    final restoredShared = _decodeScopeMap(shared, isNamespace: true);
    _privateValues
      ..clear()
      ..addAll(restoredPrivate);
    _sharedValues
      ..clear()
      ..addAll(restoredShared);
  }

  Future<void> _persist() async {
    final encoded = jsonEncode(<String, Object?>{
      'version': _formatVersion,
      'private': _privateValues,
      'shared': _sharedValues,
    });
    final file = _storeFile;
    final temporary = File('${file.path}$_temporarySuffix');
    final tempType = await FileSystemEntity.type(
      temporary.path,
      followLinks: false,
    );
    if (tempType == FileSystemEntityType.link) {
      throw const PocketCapabilityException(
        'storage_symlink',
        'Platform data temporary file must not be a symbolic link',
      );
    }
    if (tempType != FileSystemEntityType.notFound) {
      try {
        await temporary.delete();
      } on Object catch (error) {
        throw PocketCapabilityException(
          'storage_unavailable',
          'Unable to replace platform data temporary file: $error',
        );
      }
    }
    try {
      await temporary.writeAsString(encoded, flush: true);
      await temporary.rename(file.path);
    } on Object catch (error) {
      throw PocketCapabilityException(
        'storage_unavailable',
        'Unable to persist platform data: $error',
      );
    }
  }

  Map<String, Object?> _bucketFor(
    String appId,
    String key,
    String? namespace, {
    bool validateKey = true,
  }) {
    _validateAppId(appId);
    if (validateKey) _validateKey(key);
    final registration = _requireRegistered(appId);
    if (namespace == null) {
      return _privateValues.putIfAbsent(appId, () => <String, Object?>{});
    }
    _validateNamespace(namespace);
    if (!registration.sharedNamespaces.contains(namespace)) {
      throw const PocketCapabilityException(
        'shared_namespace_denied',
        'App is not allowed to access this shared namespace',
      );
    }
    return _sharedValues.putIfAbsent(namespace, () => <String, Object?>{});
  }

  _AppRegistration _requireRegistered(String appId) {
    final registration = _registrations[appId];
    if (registration == null) {
      throw const PocketCapabilityException(
        'app_not_registered',
        'App is not registered',
      );
    }
    return registration;
  }

  Set<String> _validatedSet(Set<String> values, String kind) {
    final result = <String>{};
    for (final value in values) {
      if (kind == 'namespace') {
        _validateNamespace(value);
      } else {
        _validateAppId(value);
      }
      result.add(value);
    }
    return Set<String>.unmodifiable(result);
  }

  Object? _snapshotJson(Object? value, [Set<Object>? ancestors]) {
    if (value == null || value is bool || value is String) return value;
    if (value is num) {
      if (!value.isFinite) {
        throw const PocketCapabilityException(
          'invalid_value',
          'JSON numbers must be finite',
        );
      }
      return value;
    }
    final active = ancestors ?? Set<Object>.identity();
    if (value is List) {
      if (!active.add(value)) {
        throw const PocketCapabilityException(
          'invalid_value',
          'Cyclic JSON values are not supported',
        );
      }
      try {
        return <Object?>[for (final item in value) _snapshotJson(item, active)];
      } finally {
        active.remove(value);
      }
    }
    if (value is Map) {
      if (!active.add(value)) {
        throw const PocketCapabilityException(
          'invalid_value',
          'Cyclic JSON values are not supported',
        );
      }
      try {
        final result = <String, Object?>{};
        for (final entry in value.entries) {
          if (entry.key is! String) {
            throw const PocketCapabilityException(
              'invalid_value',
              'JSON object keys must be strings',
            );
          }
          result[entry.key as String] = _snapshotJson(entry.value, active);
        }
        return result;
      } finally {
        active.remove(value);
      }
    }
    throw PocketCapabilityException(
      'invalid_value',
      'Value of type ${value.runtimeType} is not JSON-compatible',
    );
  }

  int _jsonBytes(Object? value) {
    try {
      return utf8.encode(jsonEncode(value)).length;
    } on PocketCapabilityException {
      rethrow;
    } on Object catch (error) {
      throw PocketCapabilityException(
        'invalid_value',
        'Value cannot be encoded as JSON: $error',
      );
    }
  }

  int _bucketBytes(Map<String, Object?> bucket) {
    var total = 0;
    for (final entry in bucket.entries) {
      total += _jsonBytes(<String, Object?>{entry.key: entry.value});
    }
    return total;
  }

  Map<String, Map<String, Object?>> _decodeScopeMap(
    Map<dynamic, dynamic> scopes, {
    required bool isNamespace,
  }) {
    final result = <String, Map<String, Object?>>{};
    for (final entry in scopes.entries) {
      if (entry.key is! String) {
        throw const PocketCapabilityException(
          'storage_corrupt',
          'Platform data scope IDs must be strings',
        );
      }
      final scope = entry.key as String;
      try {
        if (isNamespace) {
          _validateNamespace(scope);
        } else {
          _validateAppId(scope);
        }
      } on PocketCapabilityException catch (error) {
        throw PocketCapabilityException(
          'storage_corrupt',
          'Invalid platform data scope "$scope": ${error.message}',
        );
      }
      if (entry.value is! Map) {
        throw PocketCapabilityException(
          'storage_corrupt',
          'Storage scope "$scope" must be a JSON object',
        );
      }
      final values = <String, Object?>{};
      for (final valueEntry in (entry.value as Map).entries) {
        if (valueEntry.key is! String) {
          throw const PocketCapabilityException(
            'storage_corrupt',
            'Storage keys must be strings',
          );
        }
        final key = valueEntry.key as String;
        try {
          _validateKey(key);
          final snapshot = _snapshotJson(valueEntry.value);
          if (_jsonBytes(snapshot) > maxValueBytes) {
            throw const PocketCapabilityException(
              'storage_corrupt',
              'Stored value exceeds the configured value limit',
            );
          }
          values[key] = snapshot;
        } on PocketCapabilityException catch (error) {
          if (error.code == 'storage_corrupt') rethrow;
          throw PocketCapabilityException(
            'storage_corrupt',
            'Invalid value for storage key "$key": ${error.message}',
          );
        }
      }
      if (_bucketBytes(values) > maxAppBytes) {
        throw PocketCapabilityException(
          'storage_corrupt',
          'Storage scope "$scope" exceeds the configured quota',
        );
      }
      result[scope] = values;
    }
    return result;
  }

  void _ensureReady() {
    if (_closed) throw _closedError;
    if (!_initialized) {
      throw const PocketCapabilityException(
        'not_initialized',
        'Platform data has not been initialized',
      );
    }
  }

  void _ensureReadySync() {
    if (_closed || _closingRequested) throw _closedError;
    _ensureReady();
  }

  void _ensureNotClosed() {
    if (_closed) throw _closedError;
  }

  PocketCapabilityException get _closedError =>
      const PocketCapabilityException('closed', 'Platform data is closed');

  void _validateAppId(String value) {
    if (!_appIdPattern.hasMatch(value) ||
        utf8.encode(value).length > _maxIdentifierBytes) {
      throw PocketCapabilityException(
        'invalid_app_id',
        'Invalid Pocket app ID: $value',
      );
    }
  }

  void _validateNamespace(String value) {
    if (!_appIdPattern.hasMatch(value) ||
        utf8.encode(value).length > _maxIdentifierBytes) {
      throw PocketCapabilityException(
        'invalid_namespace',
        'Invalid namespace: $value',
      );
    }
  }

  void _validateKey(String value) {
    if (value.isEmpty ||
        value == '.' ||
        value == '..' ||
        value.contains('/') ||
        value.contains('\\') ||
        value.codeUnits.any((unit) => unit < 0x20 || unit == 0x7f) ||
        utf8.encode(value).length > _maxIdentifierBytes) {
      throw PocketCapabilityException(
        'invalid_key',
        'Invalid storage key: $value',
      );
    }
  }

  String _scopeDescription(String appId, String? namespace) =>
      namespace == null ? 'app $appId' : 'shared namespace $namespace';

  File get _storeFile =>
      File('${_directory.path}${Platform.pathSeparator}$_storeFileName');

  static final RegExp _appIdPattern = RegExp(
    r'^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$',
  );
}

final class _AppRegistration {
  const _AppRegistration(this.sharedNamespaces);

  final Set<String> sharedNamespaces;
}

Object? _cloneJson(Object? value, [Set<Object>? ancestors]) {
  if (value == null || value is bool || value is num || value is String) {
    return value;
  }
  final active = ancestors ?? Set<Object>.identity();
  if (value is List) {
    if (!active.add(value)) throw StateError('Cyclic JSON value');
    try {
      return <Object?>[for (final item in value) _cloneJson(item, active)];
    } finally {
      active.remove(value);
    }
  }
  if (value is Map) {
    if (!active.add(value)) throw StateError('Cyclic JSON value');
    try {
      final result = <String, Object?>{};
      for (final entry in value.entries) {
        if (entry.key is! String) throw StateError('Non-string JSON key');
        result[entry.key as String] = _cloneJson(entry.value, active);
      }
      return result;
    } finally {
      active.remove(value);
    }
  }
  throw StateError('Non-JSON value in Pocket platform data');
}
