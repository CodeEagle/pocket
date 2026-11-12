import 'dart:async';
import 'dart:typed_data' show Uint8List;

import 'package:pocket_flutter/src/pocket_model.dart' show PocketEvent;

import 'pocket_guest_manifest.dart';
import 'pocket_stream.dart';

typedef PocketHostSend = PocketStreamSend;
typedef PocketHostRawSend = bool Function(Map<String, dynamic> message);
typedef PocketCapabilityRequest =
    FutureOr<Object?> Function(Map<String, dynamic> params);
typedef PocketCapabilityStream =
    Stream<Object?> Function(PocketHostStreamContext context);

enum PocketCapabilityKind { request, stream }

final class PocketCapabilityAvailability {
  const PocketCapabilityAvailability({
    required this.required,
    required this.optional,
    required this.granted,
    required this.missingRequired,
    required this.unavailableOptional,
  });

  final Set<String> required;
  final Set<String> optional;
  final Set<String> granted;
  final Set<String> missingRequired;
  final Set<String> unavailableOptional;

  bool get satisfied => missingRequired.isEmpty;

  Map<String, dynamic> toJson() => <String, dynamic>{
    'required': required.toList()..sort(),
    'optional': optional.toList()..sort(),
    'granted': granted.toList()..sort(),
    'missingRequired': missingRequired.toList()..sort(),
    'unavailableOptional': unavailableOptional.toList()..sort(),
    'satisfied': satisfied,
  };
}

final class PocketCapabilityDescriptor {
  const PocketCapabilityDescriptor({
    required this.name,
    required this.kind,
    this.description = '',
  });

  final String name;
  final PocketCapabilityKind kind;
  final String description;

  Map<String, dynamic> toJson() => <String, dynamic>{
    'name': name,
    'kind': kind.name,
    if (description.isNotEmpty) 'description': description,
  };
}

final class PocketHostRegistry {
  final Map<String, _Registration> _entries = <String, _Registration>{};

  Iterable<PocketCapabilityDescriptor> get descriptors =>
      _entries.values.map((entry) => entry.descriptor);
  bool contains(String name) => _entries.containsKey(name);
  PocketCapabilityDescriptor? descriptorFor(String name) =>
      _entries[name]?.descriptor;

  void registerRequest(
    String name,
    PocketCapabilityRequest handler, {
    String description = '',
  }) {
    _register(_Registration.request(name, handler, description));
  }

  void registerStream(
    String name,
    PocketCapabilityStream handler, {
    String description = '',
  }) {
    _register(_Registration.stream(name, handler, description));
  }

  bool unregister(String name) => _entries.remove(name) != null;
  _Registration? registrationFor(String name) => _entries[name];

  void _register(_Registration entry) {
    if (!PocketCapabilityName.isValid(entry.descriptor.name)) {
      throw ArgumentError.value(
        entry.descriptor.name,
        'name',
        'must be a safe dotted capability',
      );
    }
    if (_entries.containsKey(entry.descriptor.name)) {
      throw StateError(
        'Pocket capability already registered: ${entry.descriptor.name}',
      );
    }
    _entries[entry.descriptor.name] = entry;
  }
}

final class PocketHostStreamContext {
  const PocketHostStreamContext({
    required this.capability,
    required this.port,
    Stream<Object?>? incoming,
  }) : _incoming = incoming;

  final String capability;
  final PocketDuplexStream port;
  final Stream<Object?>? _incoming;
  String get streamId => port.streamId;
  String? get topic => port.topic;
  Map<String, dynamic> get params => port.parameters;
  Stream<Object?> get incoming => _incoming ?? port.data;
}

final class PocketCapabilityException implements Exception {
  const PocketCapabilityException(this.code, this.message);

  final String code;
  final String message;

  @override
  String toString() => 'PocketCapabilityException($code): $message';
}

/// Dispatches only host-compiled providers. Guest declarations and signed
/// plugin metadata never create Dart/native code at runtime.
final class PocketHost {
  PocketHost({
    required this.registry,
    required this.streams,
    required Set<String> allowedCapabilities,
    PocketHostSend? send,
    PocketHostRawSend? sendRaw,
    Iterable<String> builtInCapabilities = const <String>{
      'text.glyphs.baked',
      'text.layout.native',
    },
  }) : allowedCapabilities = Set<String>.unmodifiable(allowedCapabilities),
       builtInCapabilities = Set<String>.unmodifiable(builtInCapabilities),
       _send = send,
       _sendRaw = sendRaw {
    if (this.allowedCapabilities.any(
          (value) => !PocketCapabilityName.isValid(value),
        ) ||
        this.builtInCapabilities.any(
          (value) => !PocketCapabilityName.isValid(value),
        )) {
      throw ArgumentError('capability allowlists contain an invalid name');
    }
    _incomingSubscription = streams.incoming.listen(_handleIncomingStream);
  }

  final PocketHostRegistry registry;
  final PocketStreamBridge streams;
  final Set<String> allowedCapabilities;
  final Set<String> builtInCapabilities;
  PocketHostSend? _send;
  PocketHostRawSend? _sendRaw;
  late final StreamSubscription<PocketDuplexStream> _incomingSubscription;
  final Set<String> _revoked = <String>{};
  final Set<String> _requests = <String>{};
  final Map<String, PocketDuplexStream> _activeStreams =
      <String, PocketDuplexStream>{};
  PocketCapabilityAvailability? _availability;
  bool _disposed = false;
  int _generation = 0;

  PocketCapabilityAvailability? get guestAvailability => _availability;

  Iterable<PocketCapabilityDescriptor> get availableCapabilities => registry
      .descriptors
      .where((descriptor) => _isProviderAvailable(descriptor.name));

  Map<String, dynamic> capabilitiesJson() => <String, dynamic>{
    'available': availableCapabilities
        .map((descriptor) => descriptor.toJson())
        .toList(growable: false),
    if (_availability != null) 'guest': _availability!.toJson(),
  };

  void attachSender(PocketHostSend send) {
    if (_disposed) throw StateError('PocketHost is disposed');
    _send = send;
  }

  void attachRawSender(PocketHostRawSend send) {
    if (_disposed) throw StateError('PocketHost is disposed');
    _sendRaw = send;
  }

  PocketCapabilityAvailability configureGuestManifest(
    PocketGuestManifest manifest,
  ) => configureGuestCapabilities(
    required: manifest.requiredCapabilities,
    optional: manifest.optionalCapabilities,
  );

  PocketCapabilityAvailability configureGuestCapabilities({
    required Iterable<String> required,
    Iterable<String> optional = const <String>[],
  }) {
    final requiredSet = _validateNames(required);
    final optionalSet = _validateNames(optional)..removeAll(requiredSet);
    final requested = <String>{...requiredSet, ...optionalSet};
    final granted = requested.where(_isProviderAvailable).toSet();
    final availability = PocketCapabilityAvailability(
      required: Set<String>.unmodifiable(requiredSet),
      optional: Set<String>.unmodifiable(optionalSet),
      granted: Set<String>.unmodifiable(granted),
      missingRequired: Set<String>.unmodifiable(
        requiredSet.difference(granted),
      ),
      unavailableOptional: Set<String>.unmodifiable(
        optionalSet.difference(granted),
      ),
    );
    _availability = availability;
    return availability;
  }

  bool isAllowed(String capability) {
    if (_revoked.contains(capability) || !_isProviderAvailable(capability)) {
      return false;
    }
    final negotiated = _availability;
    return negotiated == null || negotiated.granted.contains(capability);
  }

  void revokeCapabilities(Iterable<String> capabilities) {
    final revokedSet = capabilities.toSet();
    _revoked.addAll(revokedSet);
    final availability = _availability;
    if (availability != null) {
      final newGranted = Set<String>.from(availability.granted)
        ..removeAll(revokedSet);
      final newMissingRequired = Set<String>.from(availability.missingRequired)
        ..addAll(revokedSet.where(availability.required.contains));
      final newUnavailableOptional = Set<String>.from(
        availability.unavailableOptional,
      )..addAll(revokedSet.where(availability.optional.contains));
      _availability = PocketCapabilityAvailability(
        required: availability.required,
        optional: availability.optional,
        granted: Set<String>.unmodifiable(newGranted),
        missingRequired: Set<String>.unmodifiable(newMissingRequired),
        unavailableOptional: Set<String>.unmodifiable(newUnavailableOptional),
      );
    }
    for (final port in _activeStreams.values.toList(growable: false)) {
      if (revokedSet.contains(port.topic)) {
        // Close locally too: notifying the Guest alone leaves the native
        // producer running until the next event or eventual session teardown.
        port.cancel('capability revoked');
      }
    }
  }

  void restoreCapabilities(Iterable<String> capabilities) {
    _revoked.removeAll(capabilities);
    final availability = _availability;
    if (availability != null) {
      final toRestore = capabilities
          .where(
            (c) =>
                (availability.required.contains(c) ||
                    availability.optional.contains(c)) &&
                _isProviderAvailable(c),
          )
          .toSet();
      if (toRestore.isNotEmpty) {
        final newGranted = Set<String>.from(availability.granted)
          ..addAll(toRestore);
        final newMissingRequired = Set<String>.from(
          availability.missingRequired,
        )..removeAll(toRestore);
        final newUnavailableOptional = Set<String>.from(
          availability.unavailableOptional,
        )..removeAll(toRestore);
        _availability = PocketCapabilityAvailability(
          required: availability.required,
          optional: availability.optional,
          granted: Set<String>.unmodifiable(newGranted),
          missingRequired: Set<String>.unmodifiable(newMissingRequired),
          unavailableOptional: Set<String>.unmodifiable(newUnavailableOptional),
        );
      }
    }
  }

  Future<void> handle(PocketEvent event) async {
    if (_disposed) return;
    if (event.method.startsWith('stream.')) {
      streams.handle(event);
      return;
    }
    if (event.method != 'host.request') return;
    final requestId = '${event.params['requestId'] ?? event.id}';
    final capability = '${event.params['capability'] ?? ''}';
    final params = event.params['params'] is Map
        ? Map<String, dynamic>.from(event.params['params'] as Map)
        : <String, dynamic>{};
    if (requestId.isEmpty || capability.isEmpty) return;
    if (!_requests.add(requestId)) {
      _respondError(
        requestId,
        'duplicate_request',
        'request id is already in flight',
      );
      return;
    }
    final generation = _generation;
    try {
      if (!isAllowed(capability)) {
        throw const PocketCapabilityException(
          'capability_denied',
          'capability is not granted',
        );
      }
      final registration = registry.registrationFor(capability);
      if (registration?.request == null) {
        throw const PocketCapabilityException(
          'capability_unavailable',
          'request provider is unavailable',
        );
      }
      final value = await registration!.request!(
        Map<String, dynamic>.unmodifiable(params),
      );
      if (_disposed || generation != _generation) return;
      _assertJsonSafe(value);
      _respond(requestId, value);
    } catch (error) {
      if (error is PocketCapabilityException) {
        _respondError(requestId, error.code, error.message);
      } else {
        _respondError(requestId, 'provider_error', _safeError(error));
      }
    } finally {
      _requests.remove(requestId);
    }
  }

  void dispose() {
    if (_disposed) return;
    _disposed = true;
    _generation++;
    unawaited(_incomingSubscription.cancel());
    streams.dispose();
    _requests.clear();
    _activeStreams.clear();
  }

  bool send(String method, Map<String, dynamic> params) =>
      _send?.call(method, params) ?? false;

  bool _isProviderAvailable(String name) =>
      allowedCapabilities.contains(name) &&
      (builtInCapabilities.contains(name) || registry.contains(name));

  void _handleIncomingStream(PocketDuplexStream port) {
    final capability = port.topic ?? '';
    if (!isAllowed(capability)) {
      port.cancel('capability_denied');
      return;
    }
    final registration = registry.registrationFor(capability);
    final handler = registration?.stream;
    if (handler == null) {
      port.cancel('capability_unavailable');
      return;
    }
    _activeStreams[port.streamId] = port;
    StreamSubscription<Object?>? source;
    StreamSubscription<Object?>? lifetime;
    var ended = false;
    void stop() {
      if (ended) return;
      ended = true;
      if (identical(_activeStreams[port.streamId], port)) {
        _activeStreams.remove(port.streamId);
      }
      unawaited(source?.cancel() ?? Future<void>.value());
      unawaited(lifetime?.cancel() ?? Future<void>.value());
    }

    void fail(Object error) {
      if (ended) return;
      streams.fail(port, <String, dynamic>{
        'code': error is PocketCapabilityException
            ? error.code
            : 'provider_error',
        'message': error is PocketCapabilityException
            ? error.message
            : _safeError(error),
      });
      stop();
    }

    // One inbound subscription is shared by the provider and the lifecycle
    // observer. Previously the observer consumed a single-subscription stream,
    // preventing a genuinely bidirectional provider from listening at all.
    final incoming = port.data.asBroadcastStream(
      onCancel: (subscription) => unawaited(subscription.cancel()),
    );
    lifetime = incoming.listen(
      (_) {},
      onError: (Object _, StackTrace __) => stop(),
      onDone: stop,
    );
    try {
      final output = handler(
        PocketHostStreamContext(
          capability: capability,
          port: port,
          incoming: incoming,
        ),
      );
      source = output.listen(
        (value) {
          if (ended) return;
          if (!isAllowed(capability)) {
            port.cancel('capability revoked');
            stop();
            return;
          }
          try {
            _assertJsonSafe(value);
            if (!port.send(value)) {
              port.cancel('transport_unavailable');
              stop();
            }
          } catch (error) {
            fail(error);
          }
        },
        onError: (Object error, StackTrace _) => fail(error),
        onDone: () {
          if (ended) return;
          port.close();
          stop();
        },
        cancelOnError: true,
      );
      // A synchronous source can complete or fail during listen().
      if (ended) unawaited(source.cancel());
    } catch (error) {
      fail(error);
    }
  }

  void _respond(String requestId, Object? result) {
    if (_disposed) return;
    final params = <String, dynamic>{
      'requestId': requestId,
      'ok': true,
      'result': result,
    };
    if (!send('host.response', params))
      _sendRaw?.call(<String, dynamic>{'type': 'response', ...params});
  }

  void _respondError(String requestId, String code, String message) {
    if (_disposed) return;
    final params = <String, dynamic>{
      'requestId': requestId,
      'ok': false,
      'error': <String, dynamic>{'code': code, 'message': message},
    };
    if (!send('host.response', params))
      _sendRaw?.call(<String, dynamic>{'type': 'response', ...params});
  }

  static Set<String> _validateNames(Iterable<String> values) {
    final result = <String>{};
    for (final value in values) {
      if (!PocketCapabilityName.isValid(value))
        throw ArgumentError.value(value, 'capability', 'is not safe');
      result.add(value);
    }
    return result;
  }

  static const int _maxBridgeNestingDepth = 16;
  static const int _maxBridgeCollectionEntries = 1000000;
  static const int _maxBridgeBytes = 4 * 1024 * 1024;

  static void _assertJsonSafe(Object? value) {
    // Outbound `host.response` and `stream.data` envelopes wrap `value` two
    // levels deep (`message -> payload/params -> result/data`). Starting at
    // depth 2 keeps validation 1:1 with PocketBinaryCodec._maxNestingDepth.
    if (!_isBridgeValueSafe(value, 2, null)) {
      throw const PocketCapabilityException(
        'invalid_result',
        'provider result is not JSON-safe',
      );
    }
  }

  static bool _isBridgeValueSafe(
    Object? value,
    int depth,
    Set<Object>? ancestors,
  ) {
    if (depth > _maxBridgeNestingDepth) return false;
    if (value == null || value is bool || value is String || value is int) {
      return true;
    }
    if (value is num) return value.isFinite;
    if (value is Uint8List) {
      return value.length <= _maxBridgeBytes;
    }
    if (value is List<int>) {
      // Non-Uint8List integer lists encode as TAG_ARRAY in 0xB1 TLV.
      return value.length <= _maxBridgeCollectionEntries;
    }
    if (value is List) {
      if (value.length > _maxBridgeCollectionEntries) return false;
      final visited = ancestors ?? Set<Object>.identity();
      if (!visited.add(value)) return false;
      for (var i = 0; i < value.length; i++) {
        if (!_isBridgeValueSafe(value[i], depth + 1, visited)) {
          visited.remove(value);
          return false;
        }
      }
      visited.remove(value);
      return true;
    }
    if (value is Map) {
      if (value.length > _maxBridgeCollectionEntries) return false;
      final visited = ancestors ?? Set<Object>.identity();
      if (!visited.add(value)) return false;
      for (final entry in value.entries) {
        if (entry.key is! String ||
            !_isBridgeValueSafe(entry.value, depth + 1, visited)) {
          visited.remove(value);
          return false;
        }
      }
      visited.remove(value);
      return true;
    }
    return false;
  }

  static String _safeError(Object error) =>
      error is Exception ? error.toString() : 'provider failed';
}

final class _Registration {
  const _Registration._(this.descriptor, {this.request, this.stream});

  factory _Registration.request(
    String name,
    PocketCapabilityRequest handler,
    String description,
  ) => _Registration._(
    PocketCapabilityDescriptor(
      name: name,
      kind: PocketCapabilityKind.request,
      description: description,
    ),
    request: handler,
  );

  factory _Registration.stream(
    String name,
    PocketCapabilityStream handler,
    String description,
  ) => _Registration._(
    PocketCapabilityDescriptor(
      name: name,
      kind: PocketCapabilityKind.stream,
      description: description,
    ),
    stream: handler,
  );

  final PocketCapabilityDescriptor descriptor;
  final PocketCapabilityRequest? request;
  final PocketCapabilityStream? stream;
}
