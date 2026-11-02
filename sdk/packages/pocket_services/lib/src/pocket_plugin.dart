import 'dart:async';
import 'dart:convert';

import 'pocket_guest_manifest.dart';
import 'pocket_host.dart';
import 'pocket_stream.dart';

abstract class PocketPlugin {
  PocketPluginDescriptor get descriptor;
  void register(PocketPluginContext context) {}
  FutureOr<void> activate(PocketPluginContext context) {}
  FutureOr<void> deactivate(PocketPluginContext context) {}
  FutureOr<void> dispose() {}
}

final class PocketPermissionRequest {
  PocketPermissionRequest({
    required this.appId,
    required this.pluginId,
    required Iterable<String> requested,
    required this.reason,
  }) : requested = Set<String>.unmodifiable(requested);

  final String appId;
  final String pluginId;
  final Set<String> requested;
  final String reason;
}

typedef PocketPermissionRequestHandler =
    FutureOr<Set<String>> Function(PocketPermissionRequest request);

final class PocketPluginCapability {
  const PocketPluginCapability({
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

final class PocketPluginLimits {
  const PocketPluginLimits({
    this.memoryMb,
    this.maxConcurrentRequests,
    this.maxActiveStreams,
    this.maxResponseBytes,
    this.maxStreamEvents,
    this.maxStreamEventBytes,
  });

  final int? memoryMb;
  final int? maxConcurrentRequests;
  final int? maxActiveStreams;
  final int? maxResponseBytes;
  final int? maxStreamEvents;
  final int? maxStreamEventBytes;

  bool get isEmpty =>
      memoryMb == null &&
      maxConcurrentRequests == null &&
      maxActiveStreams == null &&
      maxResponseBytes == null &&
      maxStreamEvents == null &&
      maxStreamEventBytes == null;

  Map<String, dynamic> toJson() => <String, dynamic>{
    if (memoryMb != null) 'memoryMb': memoryMb,
    if (maxConcurrentRequests != null)
      'maxConcurrentRequests': maxConcurrentRequests,
    if (maxActiveStreams != null) 'maxActiveStreams': maxActiveStreams,
    if (maxResponseBytes != null) 'maxResponseBytes': maxResponseBytes,
    if (maxStreamEvents != null) 'maxStreamEvents': maxStreamEvents,
    if (maxStreamEventBytes != null) 'maxStreamEventBytes': maxStreamEventBytes,
  };
}

final class PocketPluginDescriptor {
  const PocketPluginDescriptor({
    required this.id,
    required this.version,
    required this.capabilities,
    this.protocolVersion = currentProtocolVersion,
    this.kind = 'capability',
    this.permissions = const <String>{},
    this.limits = const PocketPluginLimits(),
    this.description = '',
  });

  static const int currentProtocolVersion = 1;

  final int protocolVersion;
  final String id;
  final String version;
  final String kind;
  final Set<String> permissions;
  final PocketPluginLimits limits;
  final Map<String, PocketPluginCapability> capabilities;
  final String description;

  Map<String, dynamic> toJson() => <String, dynamic>{
    'protocolVersion': protocolVersion,
    'id': id,
    'version': version,
    'kind': kind,
    if (permissions.isNotEmpty) 'permissions': permissions.toList()..sort(),
    if (!limits.isEmpty) 'limits': limits.toJson(),
    if (description.isNotEmpty) 'description': description,
    'capabilities': capabilities.values
        .map((item) => item.toJson())
        .toList(growable: false),
  };
}

final class PocketPluginBudget {
  const PocketPluginBudget({
    this.maxConcurrentRequests = 8,
    this.maxActiveStreams = 8,
    this.maxResponseBytes = 256 * 1024,
    this.maxStreamEvents = 10000,
    this.maxStreamEventBytes = 256 * 1024,
  });

  final int maxConcurrentRequests;
  final int maxActiveStreams;
  final int maxResponseBytes;
  final int maxStreamEvents;
  final int maxStreamEventBytes;

  void validate() {
    if (maxConcurrentRequests <= 0 ||
        maxActiveStreams <= 0 ||
        maxResponseBytes <= 0 ||
        maxStreamEvents <= 0 ||
        maxStreamEventBytes <= 0) {
      throw ArgumentError('plugin budget values must be positive');
    }
  }
}

final class PocketPluginContext {
  PocketPluginContext({
    required this.plugin,
    required this.appId,
    required this.sessionId,
    required this.registry,
    this.budget = const PocketPluginBudget(),
  }) : _registered = <String>{} {
    budget.validate();
  }

  final PocketPluginDescriptor plugin;
  final String appId;
  final String sessionId;
  final PocketHostRegistry registry;
  final PocketPluginBudget budget;
  final Set<String> _registered;
  final Set<PocketDuplexStream> _ports = <PocketDuplexStream>{};
  final Map<String, StreamSubscription<Object?>> _subscriptions =
      <String, StreamSubscription<Object?>>{};
  int _activeRequests = 0;
  int _activeStreams = 0;
  int _generation = 0;
  bool _revoked = true;
  bool _disposed = false;

  Set<String> get registeredCapabilities =>
      Set<String>.unmodifiable(_registered);
  bool get isRevoked => _revoked;

  void registerRequest(String name, PocketCapabilityRequest handler) {
    _ensureCapability(name, PocketCapabilityKind.request);
    _ensureOpen();
    registry.registerRequest(name, (params) => _guardRequest(handler, params));
    _registered.add(name);
  }

  void registerStream(String name, PocketCapabilityStream handler) {
    _ensureCapability(name, PocketCapabilityKind.stream);
    _ensureOpen();
    registry.registerStream(name, (remote) => _guardStream(handler, remote));
    _registered.add(name);
  }

  void restore() {
    _ensureOpen();
    _revoked = false;
    _generation++;
  }

  void revoke() {
    if (_disposed) return;
    _revoked = true;
    _generation++;
    for (final subscription in _subscriptions.values.toList(growable: false)) {
      unawaited(subscription.cancel());
    }
    _subscriptions.clear();
    for (final port in _ports.toList(growable: false)) {
      if (!port.isClosed) port.cancel('plugin revoked');
    }
    _ports.clear();
    _activeStreams = 0;
  }

  void dispose() {
    if (_disposed) return;
    revoke();
    _disposed = true;
    for (final name in _registered.toList(growable: false)) {
      registry.unregister(name);
    }
    _registered.clear();
  }

  Future<Object?> _guardRequest(
    PocketCapabilityRequest handler,
    Map<String, dynamic> params,
  ) async {
    if (_revoked)
      throw const PocketCapabilityException(
        'plugin_revoked',
        'plugin is revoked',
      );
    if (_activeRequests >= budget.maxConcurrentRequests) {
      throw const PocketCapabilityException(
        'plugin_request_quota',
        'request quota exceeded',
      );
    }
    _activeRequests++;
    final generation = _generation;
    try {
      final result = await handler(Map<String, dynamic>.unmodifiable(params));
      if (_revoked || generation != _generation) {
        throw const PocketCapabilityException(
          'plugin_revoked',
          'plugin is revoked',
        );
      }
      _checkJsonBytes(result, budget.maxResponseBytes, 'plugin response');
      return result;
    } finally {
      _activeRequests--;
    }
  }

  Stream<Object?> _guardStream(
    PocketCapabilityStream handler,
    PocketHostStreamContext remote,
  ) {
    late final StreamController<Object?> controller;
    StreamSubscription<Object?>? source;
    var admitted = false;
    var events = 0;
    var cleaned = false;
    void cleanup() {
      if (cleaned) return;
      cleaned = true;
      if (admitted) _activeStreams--;
      _ports.remove(remote.port);
      _subscriptions.remove(remote.streamId);
    }

    controller = StreamController<Object?>(sync: true);
    controller.onListen = () {
      if (_revoked || _activeStreams >= budget.maxActiveStreams) {
        controller.close();
        return;
      }
      _activeStreams++;
      admitted = true;
      _ports.add(remote.port);
      final generation = _generation;
      try {
        source = handler(remote).listen(
          (value) {
            try {
              if (_revoked || generation != _generation)
                throw const PocketCapabilityException(
                  'plugin_revoked',
                  'plugin is revoked',
                );
              if (++events > budget.maxStreamEvents)
                throw const PocketCapabilityException(
                  'plugin_stream_quota',
                  'stream event quota exceeded',
                );
              _checkJsonBytes(
                value,
                budget.maxStreamEventBytes,
                'plugin stream event',
              );
              if (!controller.isClosed) controller.add(value);
            } catch (error, stack) {
              if (!controller.isClosed) controller.addError(error, stack);
              cleanup();
              unawaited(source?.cancel() ?? Future<void>.value());
              if (!controller.isClosed) controller.close();
            }
          },
          onError: (Object error, StackTrace stack) {
            if (!controller.isClosed) controller.addError(error, stack);
          },
          onDone: () {
            cleanup();
            if (!controller.isClosed) controller.close();
          },
        );
        _subscriptions[remote.streamId] = source!;
      } catch (error, stack) {
        cleanup();
        controller.addError(error, stack);
        controller.close();
      }
    };
    controller.onCancel = () async {
      final pending = source;
      source = null;
      if (pending != null) await pending.cancel();
      cleanup();
    };
    return controller.stream;
  }

  void _ensureOpen() {
    if (_disposed) throw StateError('PocketPluginContext is disposed');
  }

  void _ensureCapability(String name, PocketCapabilityKind kind) {
    _ensureOpen();
    final declared = plugin.capabilities[name];
    if (declared == null || declared.kind != kind) {
      throw ArgumentError(
        'plugin ${plugin.id} did not declare $kind capability $name',
      );
    }
  }

  static void _checkJsonBytes(Object? value, int limit, String field) {
    try {
      if (utf8.encode(jsonEncode(value)).length > limit) {
        throw PocketCapabilityException(
          'plugin_payload_quota',
          '$field exceeds byte limit',
        );
      }
    } on PocketCapabilityException {
      rethrow;
    } on Object {
      throw PocketCapabilityException(
        'plugin_payload_invalid',
        '$field is not JSON-safe',
      );
    }
  }
}

final class PocketPluginManager {
  PocketPluginManager({
    required this.host,
    required this.appId,
    required this.sessionId,
    this.budget = const PocketPluginBudget(),
    Set<String> allowedPermissions = const <String>{},
    PocketPermissionRequestHandler? onPermissionRequest,
    this.permissionReason = 'Guest requested a plugin capability',
    this.maxPluginMemoryMb = 64,
  }) : allowedPermissions = Set<String>.unmodifiable(allowedPermissions),
       permissionRequest = onPermissionRequest ?? ((_) => const <String>{}) {
    budget.validate();
    if (maxPluginMemoryMb <= 0)
      throw ArgumentError.value(maxPluginMemoryMb, 'maxPluginMemoryMb');
  }

  final PocketHost host;
  final String appId;
  final String sessionId;
  final PocketPluginBudget budget;
  final Set<String> allowedPermissions;
  final PocketPermissionRequestHandler permissionRequest;
  final String permissionReason;
  final int maxPluginMemoryMb;
  final Map<String, _PluginState> _plugins = <String, _PluginState>{};
  final Map<String, Set<String>> _grantedPermissions = <String, Set<String>>{};
  Set<String>? _guestRequestedPermissions;
  bool _disposed = false;

  Iterable<PocketPluginDescriptor> get descriptors =>
      _plugins.values.map((state) => state.plugin.descriptor);
  bool get isDisposed => _disposed;

  Map<String, dynamic> manifest() => <String, dynamic>{
    'protocolVersion': PocketPluginDescriptor.currentProtocolVersion,
    'appId': appId,
    'plugins': descriptors
        .map((descriptor) => descriptor.toJson())
        .toList(growable: false),
  };

  void register(PocketPlugin plugin) {
    _ensureOpen();
    _validateDescriptor(plugin.descriptor);
    if (_plugins.containsKey(plugin.descriptor.id))
      throw StateError('plugin already registered: ${plugin.descriptor.id}');
    final context = PocketPluginContext(
      plugin: plugin.descriptor,
      appId: appId,
      sessionId: sessionId,
      registry: host.registry,
      budget: _budgetFor(plugin.descriptor),
    );
    final state = _PluginState(plugin, context);
    _plugins[plugin.descriptor.id] = state;
    try {
      plugin.register(context);
    } catch (_) {
      _plugins.remove(plugin.descriptor.id);
      context.dispose();
      rethrow;
    }
  }

  PocketCapabilityAvailability negotiate({
    required Iterable<String> required,
    Iterable<String> optional = const <String>[],
    Iterable<String>? requestedPermissions,
  }) {
    _ensureOpen();
    if (requestedPermissions != null) {
      final requested = _validatePermissions(requestedPermissions);
      final declared = _plugins.values
          .expand((state) => state.plugin.descriptor.permissions)
          .toSet();
      final undeclared = requested.difference(declared);
      if (undeclared.isNotEmpty)
        throw PocketCapabilityException(
          'permission_not_declared',
          'undeclared permissions: ${undeclared.toList()..sort()}',
        );
      _guestRequestedPermissions = requested;
    } else {
      _guestRequestedPermissions = null;
    }
    return host.configureGuestCapabilities(
      required: required,
      optional: optional,
    );
  }

  Future<PocketCapabilityAvailability> activate(
    PocketCapabilityAvailability availability,
  ) async {
    _ensureOpen();
    final granted = availability.granted.toSet();
    // Negotiation is not activation. Revoke every inactive provider before
    // the first asynchronous permission decision can yield to guest requests.
    for (final state in _plugins.values.where((state) => !state.active)) {
      state.context.revoke();
      host.revokeCapabilities(state.plugin.descriptor.capabilities.keys);
    }
    try {
      for (final state in _plugins.values) {
        final descriptor = state.plugin.descriptor;
        final names = descriptor.capabilities.keys.toSet();
        final shouldActivate = names.any(granted.contains);
        if (!shouldActivate || state.active) continue;
        final requiredCapability = names.any(availability.required.contains);
        // A missing guest declaration is an empty declaration, never an
        // implicit grant of every permission declared by a provider.
        final requested = descriptor.permissions.intersection(
          _guestRequestedPermissions ?? const <String>{},
        );
        final notDeclared = descriptor.permissions.difference(requested);
        if (notDeclared.isNotEmpty) {
          if (requiredCapability) {
            host.revokeCapabilities(names);
            throw PocketCapabilityException(
              'permission_not_declared',
              'plugin ${descriptor.id} permissions were not declared',
            );
          }
          // An optional provider whose permissions were not declared is not
          // part of this guest session. Do not activate its Dart/native
          // implementation merely because its capability name was optional.
          granted.removeAll(names);
          host.revokeCapabilities(names);
          continue;
        }
        final pending = requested.difference(allowedPermissions);
        if (pending.isNotEmpty) {
          final approved = (await permissionRequest(
            PocketPermissionRequest(
              appId: appId,
              pluginId: descriptor.id,
              requested: pending,
              reason: permissionReason,
            ),
          )).toSet();
          if (!pending.containsAll(approved))
            throw const PocketCapabilityException(
              'invalid_permission_decision',
              'permission callback widened authority',
            );
          final denied = pending.difference(approved);
          if (denied.isNotEmpty) {
            if (requiredCapability)
              throw PocketCapabilityException(
                'plugin_permission_denied',
                'denied permissions: ${denied.toList()..sort()}',
              );
            granted.removeAll(names);
            host.revokeCapabilities(names);
            continue;
          }
          _grantedPermissions[descriptor.id] = approved;
        }
        try {
          await state.plugin.activate(state.context);
        } catch (_) {
          // A provider may have allocated resources before activate failed.
          try {
            await state.plugin.deactivate(state.context);
          } catch (_) {}
          rethrow;
        }
        state.active = true;
        state.context.restore();
        host.restoreCapabilities(names);
      }
      return PocketCapabilityAvailability(
        required: availability.required,
        optional: availability.optional,
        granted: Set<String>.unmodifiable(granted),
        missingRequired: Set<String>.unmodifiable(
          availability.required.difference(granted),
        ),
        unavailableOptional: Set<String>.unmodifiable(
          availability.optional.difference(granted),
        ),
      );
    } catch (_) {
      for (final state in _plugins.values) {
        state.context.revoke();
        host.revokeCapabilities(state.plugin.descriptor.capabilities.keys);
      }
      await deactivate();
      rethrow;
    }
  }

  Future<void> deactivate() async {
    for (final state in _plugins.values.toList(growable: false).reversed) {
      if (!state.active) continue;
      state.context.revoke();
      host.revokeCapabilities(state.plugin.descriptor.capabilities.keys);
      await state.plugin.deactivate(state.context);
      state.active = false;
      _grantedPermissions.remove(state.plugin.descriptor.id);
    }
  }

  Future<void> dispose() async {
    if (_disposed) return;
    _disposed = true;
    for (final state in _plugins.values.toList(growable: false).reversed) {
      if (state.active) {
        state.context.revoke();
        host.revokeCapabilities(state.plugin.descriptor.capabilities.keys);
        await state.plugin.deactivate(state.context);
      }
      state.context.dispose();
      await state.plugin.dispose();
    }
    _plugins.clear();
    _grantedPermissions.clear();
  }

  void _ensureOpen() {
    if (_disposed) throw StateError('PocketPluginManager is disposed');
  }

  PocketPluginBudget _budgetFor(PocketPluginDescriptor descriptor) {
    final limits = descriptor.limits;
    int min(int base, int? value) => value == null
        ? base
        : (value > 0
              ? (base < value ? base : value)
              : (throw ArgumentError('plugin limit must be positive')));
    return PocketPluginBudget(
      maxConcurrentRequests: min(
        budget.maxConcurrentRequests,
        limits.maxConcurrentRequests,
      ),
      maxActiveStreams: min(budget.maxActiveStreams, limits.maxActiveStreams),
      maxResponseBytes: min(budget.maxResponseBytes, limits.maxResponseBytes),
      maxStreamEvents: min(budget.maxStreamEvents, limits.maxStreamEvents),
      maxStreamEventBytes: min(
        budget.maxStreamEventBytes,
        limits.maxStreamEventBytes,
      ),
    );
  }

  static Set<String> _validatePermissions(Iterable<String> values) {
    final result = <String>{};
    for (final value in values) {
      if (!PocketPermissionName.isValid(value))
        throw ArgumentError.value(value, 'permission');
      result.add(value);
    }
    return result;
  }

  static void _validateDescriptor(PocketPluginDescriptor descriptor) {
    if (descriptor.protocolVersion !=
            PocketPluginDescriptor.currentProtocolVersion ||
        !RegExp(r'^[a-z][a-z0-9._-]{1,63}$').hasMatch(descriptor.id) ||
        descriptor.version.trim().isEmpty) {
      throw ArgumentError('invalid plugin descriptor');
    }
    if (descriptor.limits.memoryMb != null &&
        (descriptor.limits.memoryMb! <= 0 ||
            descriptor.limits.memoryMb! > 512)) {
      throw ArgumentError('invalid plugin memory limit');
    }
    for (final permission in descriptor.permissions) {
      if (!PocketPermissionName.isValid(permission))
        throw ArgumentError.value(permission, 'plugin.permissions');
    }
    for (final capability in descriptor.capabilities.values) {
      if (!PocketCapabilityName.isValid(capability.name))
        throw ArgumentError.value(capability.name, 'plugin.capabilities');
    }
  }
}

final class PocketPluginSession {
  PocketPluginSession(this.manager);

  final PocketPluginManager manager;
  bool _disposed = false;
  bool get isDisposed => _disposed || manager.isDisposed;

  Future<PocketCapabilityAvailability> mountGuest({
    required Iterable<String> required,
    Iterable<String> optional = const <String>[],
    Iterable<String>? requestedPermissions,
  }) async {
    if (_disposed) throw StateError('PocketPluginSession is disposed');
    final availability = manager.negotiate(
      required: required,
      optional: optional,
      requestedPermissions: requestedPermissions,
    );
    if (!availability.satisfied) {
      await manager.deactivate();
      throw PocketCapabilityException(
        'required_capability_unavailable',
        'missing: ${availability.missingRequired.toList()..sort()}',
      );
    }
    return manager.activate(availability);
  }

  Future<void> unmountGuest() => manager.deactivate();

  Future<void> dispose() async {
    if (_disposed) return;
    _disposed = true;
    await manager.dispose();
  }
}

final class _PluginState {
  _PluginState(this.plugin, this.context);

  final PocketPlugin plugin;
  final PocketPluginContext context;
  bool active = false;
}
