import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'pocket_guest_manifest.dart';
import 'pocket_host.dart';
import 'pocket_stream.dart';

abstract class PocketPlugin {
  PocketPluginDescriptor get descriptor;

  /// Trusted, resource-free coordination may finish while its caller is
  /// hidden. Hardware/stream providers retain the default foreground policy.
  bool get backgroundSafe => false;
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

/// The deliberately small, JSON-only schema vocabulary advertised by a
/// plugin descriptor.  A schema is metadata for generated client types; it is
/// not an authorization grant and does not change the host's runtime checks.
enum PocketPluginSchemaType {
  string,
  integer,
  number,
  boolean,
  nullValue,
  object,
  array,
  enumValue,
  reference,
  unknown,
}

/// A bounded serializable type node used by plugin descriptors.
///
/// Object properties which are absent from [required] are optional in the
/// generated TypeScript type.  References point to a name in the owning
/// [PocketPluginDescriptor.types] map.  No Dart code or raw TypeScript is
/// accepted by this model.
final class PocketPluginSchema {
  const PocketPluginSchema({
    required this.type,
    this.properties = const <String, PocketPluginSchema>{},
    this.required = const <String>{},
    this.items,
    this.enumValues = const <Object?>[],
    this.ref,
  });

  const PocketPluginSchema.string() : this(type: PocketPluginSchemaType.string);
  const PocketPluginSchema.integer()
    : this(type: PocketPluginSchemaType.integer);
  const PocketPluginSchema.number() : this(type: PocketPluginSchemaType.number);
  const PocketPluginSchema.boolean()
    : this(type: PocketPluginSchemaType.boolean);
  const PocketPluginSchema.nullValue()
    : this(type: PocketPluginSchemaType.nullValue);
  const PocketPluginSchema.unknown()
    : this(type: PocketPluginSchemaType.unknown);
  const PocketPluginSchema.array(PocketPluginSchema items)
    : this(type: PocketPluginSchemaType.array, items: items);
  const PocketPluginSchema.object({
    Map<String, PocketPluginSchema> properties =
        const <String, PocketPluginSchema>{},
    Set<String> required = const <String>{},
  }) : this(
         type: PocketPluginSchemaType.object,
         properties: properties,
         required: required,
       );
  const PocketPluginSchema.enumValue(List<Object?> values)
    : this(type: PocketPluginSchemaType.enumValue, enumValues: values);
  const PocketPluginSchema.reference(String name)
    : this(type: PocketPluginSchemaType.reference, ref: name);

  static const int maxDepth = 16;
  static const int maxNodes = 256;
  static const int maxProperties = 64;
  static const int maxEnumValues = 64;
  static const int maxStringLength = 256;

  final PocketPluginSchemaType type;
  final Map<String, PocketPluginSchema> properties;
  final Set<String> required;
  final PocketPluginSchema? items;
  final List<Object?> enumValues;
  final String? ref;

  Map<String, dynamic> toJson() {
    validate();
    return _toJsonUnchecked();
  }

  factory PocketPluginSchema.fromJson(Object? value) {
    final map = _schemaMap(value, 'schema');
    final rawType = map['type'];
    if (rawType == null && map['\$ref'] is String) {
      _rejectSchemaFields(map, const <String>{'\$ref'}, 'schema');
      return PocketPluginSchema.reference(map['\$ref'] as String)..validate();
    }
    if (rawType is! String) {
      throw const FormatException('plugin schema type must be a string');
    }
    final type = _schemaTypeFromWire(rawType);
    switch (type) {
      case PocketPluginSchemaType.object:
        _rejectSchemaFields(map, const <String>{
          'type',
          'properties',
          'required',
        }, 'schema');
        final rawProperties = map['properties'];
        final properties = <String, PocketPluginSchema>{};
        if (rawProperties != null) {
          final propertyMap = _schemaMap(rawProperties, 'schema.properties');
          for (final entry in propertyMap.entries) {
            properties[entry.key] = PocketPluginSchema.fromJson(entry.value);
          }
        }
        final rawRequired = map['required'];
        final required = <String>{};
        if (rawRequired != null) {
          if (rawRequired is! List) {
            throw const FormatException(
              'plugin schema required must be an array',
            );
          }
          for (final item in rawRequired) {
            if (item is! String) {
              throw const FormatException(
                'plugin schema required names must be strings',
              );
            }
            required.add(item);
          }
        }
        return PocketPluginSchema.object(
          properties: properties,
          required: required,
        )..validate();
      case PocketPluginSchemaType.array:
        _rejectSchemaFields(map, const <String>{'type', 'items'}, 'schema');
        return PocketPluginSchema.array(
          PocketPluginSchema.fromJson(map['items']),
        )..validate();
      case PocketPluginSchemaType.enumValue:
        _rejectSchemaFields(map, const <String>{'type', 'values'}, 'schema');
        final values = map['values'];
        if (values is! List) {
          throw const FormatException(
            'plugin enum schema values must be an array',
          );
        }
        return PocketPluginSchema.enumValue(List<Object?>.from(values))
          ..validate();
      case PocketPluginSchemaType.reference:
        _rejectSchemaFields(map, const <String>{'type', 'ref'}, 'schema');
        final name = map['ref'];
        if (name is! String) {
          throw const FormatException(
            'plugin reference schema ref must be a string',
          );
        }
        return PocketPluginSchema.reference(name)..validate();
      case PocketPluginSchemaType.string:
        _rejectSchemaFields(map, const <String>{'type'}, 'schema');
        return const PocketPluginSchema.string();
      case PocketPluginSchemaType.integer:
        _rejectSchemaFields(map, const <String>{'type'}, 'schema');
        return const PocketPluginSchema.integer();
      case PocketPluginSchemaType.number:
        _rejectSchemaFields(map, const <String>{'type'}, 'schema');
        return const PocketPluginSchema.number();
      case PocketPluginSchemaType.boolean:
        _rejectSchemaFields(map, const <String>{'type'}, 'schema');
        return const PocketPluginSchema.boolean();
      case PocketPluginSchemaType.nullValue:
        _rejectSchemaFields(map, const <String>{'type'}, 'schema');
        return const PocketPluginSchema.nullValue();
      case PocketPluginSchemaType.unknown:
        _rejectSchemaFields(map, const <String>{'type'}, 'schema');
        return const PocketPluginSchema.unknown();
    }
  }

  /// Validates the local schema grammar and resource bounds.  Descriptor
  /// validation additionally checks that every reference resolves.
  void validate() {
    final state = _SchemaValidationState();
    _validateSchema(this, state, 'schema');
  }

  Map<String, dynamic> _toJsonUnchecked() {
    switch (type) {
      case PocketPluginSchemaType.object:
        return <String, dynamic>{
          'type': 'object',
          if (properties.isNotEmpty)
            'properties': <String, dynamic>{
              for (final key in properties.keys.toList()..sort())
                key: properties[key]!._toJsonUnchecked(),
            },
          if (required.isNotEmpty) 'required': required.toList()..sort(),
        };
      case PocketPluginSchemaType.array:
        return <String, dynamic>{
          'type': 'array',
          'items': items!._toJsonUnchecked(),
        };
      case PocketPluginSchemaType.enumValue:
        return <String, dynamic>{'type': 'enum', 'values': enumValues};
      case PocketPluginSchemaType.reference:
        return <String, dynamic>{'type': 'ref', 'ref': ref};
      case PocketPluginSchemaType.string:
        return <String, dynamic>{'type': 'string'};
      case PocketPluginSchemaType.integer:
        return <String, dynamic>{'type': 'integer'};
      case PocketPluginSchemaType.number:
        return <String, dynamic>{'type': 'number'};
      case PocketPluginSchemaType.boolean:
        return <String, dynamic>{'type': 'boolean'};
      case PocketPluginSchemaType.nullValue:
        return <String, dynamic>{'type': 'null'};
      case PocketPluginSchemaType.unknown:
        return <String, dynamic>{'type': 'unknown'};
    }
  }
}

Map<String, dynamic> _schemaMap(Object? value, String field) {
  if (value is! Map) throw FormatException('$field must be an object');
  final result = <String, dynamic>{};
  for (final entry in value.entries) {
    if (entry.key is! String) {
      throw FormatException('$field keys must be strings');
    }
    result[entry.key as String] = entry.value;
  }
  return result;
}

PocketPluginSchemaType _schemaTypeFromWire(String value) {
  switch (value) {
    case 'string':
      return PocketPluginSchemaType.string;
    case 'integer':
      return PocketPluginSchemaType.integer;
    case 'number':
      return PocketPluginSchemaType.number;
    case 'boolean':
      return PocketPluginSchemaType.boolean;
    case 'null':
      return PocketPluginSchemaType.nullValue;
    case 'object':
      return PocketPluginSchemaType.object;
    case 'array':
      return PocketPluginSchemaType.array;
    case 'enum':
      return PocketPluginSchemaType.enumValue;
    case 'ref':
      return PocketPluginSchemaType.reference;
    case 'unknown':
      return PocketPluginSchemaType.unknown;
    default:
      throw FormatException('unsupported plugin schema type: $value');
  }
}

void _rejectSchemaFields(
  Map<String, dynamic> map,
  Set<String> allowed,
  String field,
) {
  final unknown = map.keys.where((key) => !allowed.contains(key)).toList()
    ..sort();
  if (unknown.isNotEmpty) {
    throw FormatException('$field has unknown fields: ${unknown.join(', ')}');
  }
}

final class _SchemaValidationState {
  int nodes = 0;
}

void _validateSchema(
  PocketPluginSchema schema,
  _SchemaValidationState state,
  String path, [
  int depth = 0,
]) {
  if (depth > PocketPluginSchema.maxDepth) {
    throw ArgumentError(
      '$path exceeds schema depth ${PocketPluginSchema.maxDepth}',
    );
  }
  state.nodes++;
  if (state.nodes > PocketPluginSchema.maxNodes) {
    throw ArgumentError(
      'plugin schema exceeds ${PocketPluginSchema.maxNodes} nodes',
    );
  }
  switch (schema.type) {
    case PocketPluginSchemaType.object:
      if (schema.properties.length > PocketPluginSchema.maxProperties) {
        throw ArgumentError(
          '$path exceeds ${PocketPluginSchema.maxProperties} properties',
        );
      }
      if (schema.items != null ||
          schema.enumValues.isNotEmpty ||
          schema.ref != null) {
        throw ArgumentError('$path object schema has incompatible fields');
      }
      for (final entry in schema.properties.entries) {
        if (entry.key.isEmpty ||
            entry.key.length > PocketPluginSchema.maxStringLength ||
            entry.key.contains('\u0000')) {
          throw ArgumentError('$path has an invalid property name');
        }
        _validateSchema(
          entry.value,
          state,
          '$path.properties.${entry.key}',
          depth + 1,
        );
      }
      if (!schema.properties.keys.toSet().containsAll(schema.required)) {
        throw ArgumentError('$path.required contains an undeclared property');
      }
      break;
    case PocketPluginSchemaType.array:
      if (schema.items == null ||
          schema.properties.isNotEmpty ||
          schema.required.isNotEmpty ||
          schema.enumValues.isNotEmpty ||
          schema.ref != null) {
        throw ArgumentError('$path array schema has incompatible fields');
      }
      _validateSchema(schema.items!, state, '$path.items', depth + 1);
      break;
    case PocketPluginSchemaType.enumValue:
      if (schema.enumValues.isEmpty ||
          schema.enumValues.length > PocketPluginSchema.maxEnumValues ||
          schema.properties.isNotEmpty ||
          schema.required.isNotEmpty ||
          schema.items != null ||
          schema.ref != null) {
        throw ArgumentError('$path enum schema is invalid');
      }
      for (final value in schema.enumValues) {
        if (value is! String &&
            value is! num &&
            value is! bool &&
            value != null) {
          throw ArgumentError('$path enum values must be JSON primitives');
        }
        if (value is double && !value.isFinite) {
          throw ArgumentError('$path enum values must be finite');
        }
        if (value is String &&
            value.length > PocketPluginSchema.maxStringLength) {
          throw ArgumentError('$path enum string is too long');
        }
      }
      break;
    case PocketPluginSchemaType.reference:
      if (schema.ref == null ||
          !RegExp(r'^[A-Za-z][A-Za-z0-9_]{0,63}$').hasMatch(schema.ref!) ||
          schema.properties.isNotEmpty ||
          schema.required.isNotEmpty ||
          schema.items != null ||
          schema.enumValues.isNotEmpty) {
        throw ArgumentError('$path reference schema is invalid');
      }
      break;
    case PocketPluginSchemaType.string:
    case PocketPluginSchemaType.integer:
    case PocketPluginSchemaType.number:
    case PocketPluginSchemaType.boolean:
    case PocketPluginSchemaType.nullValue:
    case PocketPluginSchemaType.unknown:
      if (schema.properties.isNotEmpty ||
          schema.required.isNotEmpty ||
          schema.items != null ||
          schema.enumValues.isNotEmpty ||
          schema.ref != null) {
        throw ArgumentError('$path primitive schema has incompatible fields');
      }
  }
}

void _collectSchemaReferences(
  PocketPluginSchema schema,
  Set<String> references,
) {
  switch (schema.type) {
    case PocketPluginSchemaType.reference:
      references.add(schema.ref!);
    case PocketPluginSchemaType.object:
      for (final child in schema.properties.values) {
        _collectSchemaReferences(child, references);
      }
    case PocketPluginSchemaType.array:
      _collectSchemaReferences(schema.items!, references);
    case PocketPluginSchemaType.string:
    case PocketPluginSchemaType.integer:
    case PocketPluginSchemaType.number:
    case PocketPluginSchemaType.boolean:
    case PocketPluginSchemaType.nullValue:
    case PocketPluginSchemaType.enumValue:
    case PocketPluginSchemaType.unknown:
      break;
  }
}

/// Schemas for one capability's request parameters, request result, or
/// stream item.  Existing descriptors may omit this object entirely.
final class PocketPluginCapabilitySchema {
  const PocketPluginCapabilitySchema({
    this.parameters,
    this.result,
    this.streamItem,
  });

  final PocketPluginSchema? parameters;
  final PocketPluginSchema? result;
  final PocketPluginSchema? streamItem;

  bool get isEmpty =>
      parameters == null && result == null && streamItem == null;

  Map<String, dynamic> toJson() => <String, dynamic>{
    if (parameters != null) 'parameters': parameters!.toJson(),
    if (result != null) 'result': result!.toJson(),
    if (streamItem != null) 'streamItem': streamItem!.toJson(),
  };

  factory PocketPluginCapabilitySchema.fromJson(Object? value) {
    final map = _schemaMap(value, 'capability.schema');
    final allowed = const <String>{'parameters', 'result', 'streamItem'};
    final unknown = map.keys.where((key) => !allowed.contains(key));
    if (unknown.isNotEmpty) {
      throw FormatException(
        'unknown capability schema fields: ${unknown.join(', ')}',
      );
    }
    return PocketPluginCapabilitySchema(
      parameters: map.containsKey('parameters')
          ? PocketPluginSchema.fromJson(map['parameters'])
          : null,
      result: map.containsKey('result')
          ? PocketPluginSchema.fromJson(map['result'])
          : null,
      streamItem: map.containsKey('streamItem')
          ? PocketPluginSchema.fromJson(map['streamItem'])
          : null,
    );
  }
}

final class PocketPluginCapability {
  const PocketPluginCapability({
    required this.name,
    required this.kind,
    this.description = '',
    this.permissions,
    this.optionalPermissions = const <String>{},
    this.schema,
  });

  final String name;
  final PocketCapabilityKind kind;
  final String description;
  final Set<String>? permissions;
  final Set<String> optionalPermissions;
  final PocketPluginCapabilitySchema? schema;

  Map<String, dynamic> toJson() => <String, dynamic>{
    'name': name,
    'kind': kind.name,
    if (description.isNotEmpty) 'description': description,
    if (permissions != null && permissions!.isNotEmpty)
      'permissions': permissions!.toList()..sort(),
    if (optionalPermissions.isNotEmpty)
      'optionalPermissions': optionalPermissions.toList()..sort(),
    if (schema != null && !schema!.isEmpty) 'schema': schema!.toJson(),
  };
}

typedef PocketPluginMethod = PocketPluginCapability;

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
    this.optionalPermissions = const <String>{},
    this.limits = const PocketPluginLimits(),
    this.description = '',
    this.types = const <String, PocketPluginSchema>{},
  });

  static const int currentProtocolVersion = 1;

  final int protocolVersion;
  final String id;
  final String version;
  final String kind;
  final Set<String> permissions;
  final Set<String> optionalPermissions;
  final PocketPluginLimits limits;
  final Map<String, PocketPluginCapability> capabilities;
  final String description;
  final Map<String, PocketPluginSchema> types;

  Map<String, dynamic> toJson() {
    validateSchemas();
    return <String, dynamic>{
      'protocolVersion': protocolVersion,
      'id': id,
      'version': version,
      'kind': kind,
      if (permissions.isNotEmpty) 'permissions': permissions.toList()..sort(),
      if (optionalPermissions.isNotEmpty)
        'optionalPermissions': optionalPermissions.toList()..sort(),
      if (!limits.isEmpty) 'limits': limits.toJson(),
      if (description.isNotEmpty) 'description': description,
      if (types.isNotEmpty)
        'types': <String, dynamic>{
          for (final name in types.keys.toList()..sort())
            name: types[name]!._toJsonUnchecked(),
        },
      'capabilities': capabilities.values
          .map((item) => item.toJson())
          .toList(growable: false),
    };
  }

  /// Validates schema metadata without changing permission or lifecycle
  /// semantics.  Called at serialization and plugin admission boundaries.
  void validateSchemas() {
    if (types.length > 128) {
      throw ArgumentError('plugin schema type count exceeds 128');
    }
    for (final entry in types.entries) {
      if (!RegExp(r'^[A-Za-z][A-Za-z0-9_]{0,63}$').hasMatch(entry.key)) {
        throw ArgumentError.value(
          entry.key,
          'plugin.types',
          'invalid type name',
        );
      }
      entry.value.validate();
    }
    final references = <String>{};
    for (final entry in types.entries) {
      _collectSchemaReferences(entry.value, references);
    }
    for (final capability in capabilities.values) {
      final schema = capability.schema;
      if (schema == null) continue;
      for (final node in <PocketPluginSchema?>[
        schema.parameters,
        schema.result,
        schema.streamItem,
      ]) {
        if (node != null) _collectSchemaReferences(node, references);
      }
    }
    final missing = references.difference(types.keys.toSet());
    if (missing.isNotEmpty) {
      throw ArgumentError(
        'plugin schema references are not declared: ${missing.toList()..sort()}',
      );
    }
    final encoded = utf8.encode(
      jsonEncode(<String, dynamic>{
        'types': <String, dynamic>{
          for (final name in types.keys.toList()..sort())
            name: types[name]!._toJsonUnchecked(),
        },
        'capabilities': capabilities.values
            .map((item) => item.toJson())
            .toList(growable: false),
      }),
    );
    if (encoded.length > 64 * 1024) {
      throw ArgumentError('plugin schema metadata exceeds 64KiB');
    }
  }
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
    Set<String> Function()? grantedPermissionsLookup,
  }) : _registered = <String>{},
       _grantedPermissionsLookup = grantedPermissionsLookup {
    budget.validate();
  }

  final PocketPluginDescriptor plugin;
  final String appId;
  final String sessionId;
  final PocketHostRegistry registry;
  final PocketPluginBudget budget;
  Set<String> Function()? _grantedPermissionsLookup;
  set grantedPermissionsLookup(Set<String> Function()? lookup) =>
      _grantedPermissionsLookup = lookup;
  Set<String> get grantedPermissions =>
      _grantedPermissionsLookup?.call() ?? const <String>{};

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
    registry.registerRequest(
      name,
      (params) => _guardRequest(name, handler, params),
    );
    _registered.add(name);
  }

  void registerStream(String name, PocketCapabilityStream handler) {
    _ensureCapability(name, PocketCapabilityKind.stream);
    _ensureOpen();
    registry.registerStream(
      name,
      (remote) => _guardStream(name, handler, remote),
    );
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
    String capabilityName,
    PocketCapabilityRequest handler,
    Map<String, dynamic> params,
  ) async {
    if (_revoked) {
      throw const PocketCapabilityException(
        'plugin_revoked',
        'plugin is revoked',
      );
    }
    final method = plugin.capabilities[capabilityName];
    if (method != null) {
      final requiredPerms = method.permissions ?? plugin.permissions;
      final missing = requiredPerms.difference(grantedPermissions);
      if (missing.isNotEmpty) {
        throw PocketCapabilityException(
          'permission_denied',
          'missing permissions: ${missing.toList()..sort()}',
        );
      }
    }
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
      _checkPayloadBytes(result, budget.maxResponseBytes, 'plugin response');
      return result;
    } finally {
      _activeRequests--;
    }
  }

  Stream<Object?> _guardStream(
    String capabilityName,
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
      final method = plugin.capabilities[capabilityName];
      if (method != null) {
        final requiredPerms = method.permissions ?? plugin.permissions;
        final missing = requiredPerms.difference(grantedPermissions);
        if (missing.isNotEmpty) {
          controller.addError(
            PocketCapabilityException(
              'permission_denied',
              'missing permissions: ${missing.toList()..sort()}',
            ),
          );
          controller.close();
          return;
        }
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
              _checkPayloadBytes(
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

  // Ordinary values retain their UTF-8 JSON quota. Typed byte buffers use
  // their binary payload size plus the bridge's tag/length header, rather
  // than expanding each byte into a JSON number. Count before transport
  // encoding, without copying buffers or allocating a whole JSON document.
  static void _checkPayloadBytes(Object? value, int limit, String field) {
    var used = 0;
    final ancestors = Set<Object>.identity();
    void add(int bytes) {
      used += bytes;
      if (used > limit) {
        throw PocketCapabilityException(
          'plugin_payload_quota',
          '$field exceeds byte limit',
        );
      }
    }

    void visit(Object? item) {
      if (item is Uint8List) {
        add(5 + item.lengthInBytes);
      } else if (item is List) {
        if (!ancestors.add(item)) throw const FormatException('Cyclic list');
        try {
          add(2 + (item.isEmpty ? 0 : item.length - 1));
          for (final child in item) {
            visit(child);
          }
        } finally {
          ancestors.remove(item);
        }
      } else if (item is Map) {
        if (!ancestors.add(item)) throw const FormatException('Cyclic map');
        try {
          add(2 + (item.isEmpty ? 0 : item.length - 1));
          for (final entry in item.entries) {
            if (entry.key is! String) {
              throw const FormatException('Object keys must be strings');
            }
            add(utf8.encode(jsonEncode(entry.key)).length + 1);
            visit(entry.value);
          }
        } finally {
          ancestors.remove(item);
        }
      } else {
        // Retain JsonEncoder's scalar/toJson validation and escaping.
        add(utf8.encode(jsonEncode(item)).length);
      }
    }

    try {
      visit(value);
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
      grantedPermissionsLookup: () =>
          grantedPermissionsFor(plugin.descriptor.id),
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
      final declared = _plugins.values.expand((state) {
        final desc = state.plugin.descriptor;
        final methodPerms = desc.capabilities.values.expand(
          (m) => (m.permissions ?? desc.permissions).followedBy(
            m.optionalPermissions,
          ),
        );
        return desc.permissions
            .followedBy(desc.optionalPermissions)
            .followedBy(methodPerms);
      }).toSet();
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
        final shouldActivate = names.isEmpty
            ? descriptor.permissions.isNotEmpty
            : names.any(granted.contains);
        if (!shouldActivate || state.active) continue;
        final requiredCapability = names.any(availability.required.contains);

        if (_guestRequestedPermissions != null) {
          for (final method in descriptor.capabilities.values) {
            if (!granted.contains(method.name)) continue;
            final methodPerms = method.permissions ?? descriptor.permissions;
            final notDeclared = methodPerms.difference(
              _guestRequestedPermissions!,
            );
            if (notDeclared.isNotEmpty) {
              if (availability.required.contains(method.name)) {
                host.revokeCapabilities(names);
                throw PocketCapabilityException(
                  'permission_not_declared',
                  'plugin ${descriptor.id} capability ${method.name} permissions were not declared',
                );
              } else {
                granted.remove(method.name);
                host.revokeCapabilities(<String>[method.name]);
              }
            }
          }
        }

        final grantedMethods = descriptor.capabilities.values
            .where((m) => granted.contains(m.name))
            .toList();

        if (descriptor.capabilities.isNotEmpty && grantedMethods.isEmpty) {
          if (descriptor.permissions.isEmpty) {
            host.revokeCapabilities(names);
            continue;
          }
        }

        final requestedPermissionsForPlugin = grantedMethods.isNotEmpty
            ? grantedMethods
                  .expand((m) => m.permissions ?? descriptor.permissions)
                  .toSet()
            : (descriptor.capabilities.isEmpty
                  ? descriptor.permissions.intersection(
                      _guestRequestedPermissions ?? descriptor.permissions,
                    )
                  : const <String>{});

        if (descriptor.capabilities.isEmpty &&
            _guestRequestedPermissions != null) {
          final notDeclared = descriptor.permissions.difference(
            _guestRequestedPermissions!,
          );
          if (notDeclared.isNotEmpty) {
            if (requiredCapability) {
              host.revokeCapabilities(names);
              throw PocketCapabilityException(
                'permission_not_declared',
                'plugin ${descriptor.id} permissions were not declared',
              );
            }
            continue;
          }
        }

        var approvedPermissions = const <String>{};
        final pending = requestedPermissionsForPlugin.difference(
          allowedPermissions,
        );
        if (pending.isNotEmpty) {
          final approved = (await permissionRequest(
            PocketPermissionRequest(
              appId: appId,
              pluginId: descriptor.id,
              requested: pending,
              reason: permissionReason,
            ),
          )).toSet();
          if (!pending.containsAll(approved)) {
            throw const PocketCapabilityException(
              'invalid_permission_decision',
              'permission callback widened authority',
            );
          }
          approvedPermissions = approved;
          final denied = pending.difference(approved);
          if (denied.isNotEmpty) {
            for (final method in grantedMethods.toList()) {
              final methodPerms = method.permissions ?? descriptor.permissions;
              if (methodPerms.intersection(denied).isNotEmpty) {
                if (availability.required.contains(method.name)) {
                  throw PocketCapabilityException(
                    'plugin_permission_denied',
                    'denied permissions: ${denied.toList()..sort()}',
                  );
                } else {
                  granted.remove(method.name);
                  host.revokeCapabilities(<String>[method.name]);
                }
              }
            }
            if (descriptor.capabilities.isEmpty && denied.isNotEmpty) {
              if (requiredCapability) {
                throw PocketCapabilityException(
                  'plugin_permission_denied',
                  'denied permissions: ${denied.toList()..sort()}',
                );
              } else {
                continue;
              }
            }
          }
        }

        if (descriptor.capabilities.isNotEmpty &&
            !names.any(granted.contains)) {
          host.revokeCapabilities(names);
          continue;
        }

        final effectiveAllowed = allowedPermissions.union(approvedPermissions);
        final effectiveGranted = _guestRequestedPermissions != null
            ? _guestRequestedPermissions!.intersection(effectiveAllowed)
            : effectiveAllowed;
        _grantedPermissions[descriptor.id] = Set<String>.unmodifiable(
          effectiveGranted,
        );

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
        host.restoreCapabilities(names.where(granted.contains));
        host.revokeCapabilities(names.where((n) => !granted.contains(n)));
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

  Future<void> deactivate({bool foregroundOnly = false}) async {
    for (final state in _plugins.values.toList(growable: false).reversed) {
      if (!state.active) continue;
      if (foregroundOnly && state.plugin.backgroundSafe) continue;
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

  Set<String> grantedPermissionsFor(String pluginId) =>
      _grantedPermissions[pluginId] ??
      (_guestRequestedPermissions != null
          ? _guestRequestedPermissions!.intersection(allowedPermissions)
          : allowedPermissions);

  Future<Object?> invoke(
    String capabilityName, [
    Map<String, dynamic> params = const <String, dynamic>{},
  ]) async {
    _ensureOpen();
    for (final state in _plugins.values) {
      final method = state.plugin.descriptor.capabilities[capabilityName];
      if (method != null) {
        if (!state.active || !host.isAllowed(capabilityName)) {
          throw PocketCapabilityException(
            'capability_denied',
            'capability $capabilityName is not granted',
          );
        }
        final plugin = state.plugin;
        final effectiveGranted =
            _grantedPermissions[plugin.descriptor.id] ??
            (_guestRequestedPermissions != null
                ? _guestRequestedPermissions!.intersection(allowedPermissions)
                : allowedPermissions);
        final requiredPermissions =
            method.permissions ?? plugin.descriptor.permissions;
        final missingPermissions = requiredPermissions.difference(
          effectiveGranted,
        );
        if (missingPermissions.isNotEmpty) {
          throw PocketCapabilityException(
            'plugin_permission_denied',
            'missing permissions: ${missingPermissions.toList()..sort()}',
          );
        }
        final registration = host.registry.registrationFor(capabilityName);
        if (registration?.request == null) {
          throw const PocketCapabilityException(
            'capability_unavailable',
            'request provider is unavailable',
          );
        }
        return await registration!.request!(params);
      }
    }
    throw PocketCapabilityException(
      'capability_not_found',
      'capability $capabilityName not found',
    );
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
    for (final permission in descriptor.optionalPermissions) {
      if (!PocketPermissionName.isValid(permission))
        throw ArgumentError.value(permission, 'plugin.optionalPermissions');
    }
    for (final capability in descriptor.capabilities.values) {
      if (!PocketCapabilityName.isValid(capability.name))
        throw ArgumentError.value(capability.name, 'plugin.capabilities');
      if (capability.permissions != null) {
        for (final permission in capability.permissions!) {
          if (!PocketPermissionName.isValid(permission)) {
            throw ArgumentError.value(permission, 'capability.permissions');
          }
        }
      }
      for (final permission in capability.optionalPermissions) {
        if (!PocketPermissionName.isValid(permission)) {
          throw ArgumentError.value(
            permission,
            'capability.optionalPermissions',
          );
        }
      }
    }
    descriptor.validateSchemas();
  }
}

typedef PocketPluginRegistry = PocketPluginManager;

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
