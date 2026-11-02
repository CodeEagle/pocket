import 'dart:async';
import 'dart:convert';

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
  const PocketHostStreamContext({required this.capability, required this.port});

  final String capability;
  final PocketDuplexStream port;
  String get streamId => port.streamId;
  String? get topic => port.topic;
  Map<String, dynamic> get params => port.parameters;
  Stream<Object?> get incoming => port.data;
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
    Iterable<String> builtInCapabilities = const <String>{'text.glyphs.baked'},
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
  final Set<String> _activeStreams = <String>{};
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
    _revoked.addAll(capabilities);
    final availability = _availability;
    if (availability != null) {
      final revokedSet = capabilities.toSet();
      final newGranted = Set<String>.from(availability.granted)
        ..removeAll(revokedSet);
      final newMissingRequired = Set<String>.from(availability.missingRequired)
        ..addAll(revokedSet.where(availability.required.contains));
      final newUnavailableOptional =
          Set<String>.from(availability.unavailableOptional)
            ..addAll(revokedSet.where(availability.optional.contains));
      _availability = PocketCapabilityAvailability(
        required: availability.required,
        optional: availability.optional,
        granted: Set<String>.unmodifiable(newGranted),
        missingRequired: Set<String>.unmodifiable(newMissingRequired),
        unavailableOptional: Set<String>.unmodifiable(newUnavailableOptional),
      );
    }
    for (final streamId in _activeStreams.toList(growable: false)) {
      // The bridge owns stream lifecycle; a cancellation packet is enough to
      // close the remote side even when a provider is being torn down.
      send('stream.cancel', <String, dynamic>{
        'streamId': streamId,
        'reason': 'capability revoked',
      });
      _activeStreams.remove(streamId);
    }
  }

  void restoreCapabilities(Iterable<String> capabilities) {
    _revoked.removeAll(capabilities);
    final availability = _availability;
    if (availability != null) {
      final toRestore = capabilities.where(
        (c) =>
            (availability.required.contains(c) ||
                availability.optional.contains(c)) &&
            _isProviderAvailable(c),
      ).toSet();
      if (toRestore.isNotEmpty) {
        final newGranted = Set<String>.from(availability.granted)
          ..addAll(toRestore);
        final newMissingRequired =
            Set<String>.from(availability.missingRequired)
              ..removeAll(toRestore);
        final newUnavailableOptional =
            Set<String>.from(availability.unavailableOptional)
              ..removeAll(toRestore);
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
    _activeStreams.add(port.streamId);
    final output = handler(
      PocketHostStreamContext(capability: capability, port: port),
    );
    final subscription = output.listen(
      (value) {
        if (isAllowed(capability)) port.send(value);
      },
      onError: (Object error, StackTrace _) => port.close(_safeError(error)),
      onDone: () {
        _activeStreams.remove(port.streamId);
        port.close();
      },
      cancelOnError: true,
    );
    port.data.listen((_) {}, onDone: () => unawaited(subscription.cancel()));
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

  static void _assertJsonSafe(Object? value) {
    try {
      jsonEncode(value);
    } on Object {
      throw const PocketCapabilityException(
        'invalid_result',
        'provider result is not JSON-safe',
      );
    }
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
