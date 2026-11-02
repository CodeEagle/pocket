import 'dart:convert';

/// The small, signed capability contract carried by a guest package.
///
/// This is intentionally not called `game.config`: it is package metadata,
/// not an editor/runtime configuration format. The host remains the final
/// authority; this declaration can only reduce what a guest may request.
final class PocketGuestManifest {
  const PocketGuestManifest({
    this.requiredCapabilities = const <String>{},
    this.optionalCapabilities = const <String>{},
    this.requiredPermissions = const <String>{},
    this.optionalPermissions = const <String>{},
  });

  factory PocketGuestManifest.fromJson(Object? value) {
    if (value is! Map) {
      throw const FormatException('guest manifest must be an object');
    }
    final json = Map<String, dynamic>.from(value);
    // Accept both a nested declaration and the top-level manifest fields.
    final rawCapabilities = json['capabilities'];
    final rawPermissions = json['permissions'];
    final capabilities = rawCapabilities == null
        ? const <String, dynamic>{}
        : _asObject(rawCapabilities, 'capabilities');
    final permissions = rawPermissions == null
        ? const <String, dynamic>{}
        : _asObject(rawPermissions, 'permissions');
    final requiredCapabilities = _readNames(
      capabilities['requires'] ?? capabilities['required'],
      'capabilities.requires',
    );
    final optionalCapabilities = _readNames(
      capabilities['optional'],
      'capabilities.optional',
    );
    final requiredPermissions = _readNames(
      permissions['requires'] ?? permissions['required'],
      'permissions.requires',
      permission: true,
    );
    final optionalPermissions = _readNames(
      permissions['optional'],
      'permissions.optional',
      permission: true,
    );
    optionalCapabilities.removeAll(requiredCapabilities);
    optionalPermissions.removeAll(requiredPermissions);
    return PocketGuestManifest(
      requiredCapabilities: Set<String>.unmodifiable(requiredCapabilities),
      optionalCapabilities: Set<String>.unmodifiable(optionalCapabilities),
      requiredPermissions: Set<String>.unmodifiable(requiredPermissions),
      optionalPermissions: Set<String>.unmodifiable(optionalPermissions),
    );
  }

  factory PocketGuestManifest.fromJsonString(String source) =>
      PocketGuestManifest.fromJson(jsonDecode(source));

  final Set<String> requiredCapabilities;
  final Set<String> optionalCapabilities;
  final Set<String> requiredPermissions;
  final Set<String> optionalPermissions;

  Set<String> get declaredCapabilities => <String>{
    ...requiredCapabilities,
    ...optionalCapabilities,
  };

  Set<String> get declaredPermissions => <String>{
    ...requiredPermissions,
    ...optionalPermissions,
  };

  Map<String, dynamic> toJson() => <String, dynamic>{
    'capabilities': <String, dynamic>{
      'requires': requiredCapabilities.toList()..sort(),
      'optional': optionalCapabilities.toList()..sort(),
    },
    if (declaredPermissions.isNotEmpty)
      'permissions': <String, dynamic>{
        'requires': requiredPermissions.toList()..sort(),
        'optional': optionalPermissions.toList()..sort(),
      },
  };

  static Map<String, dynamic> _asObject(Object value, String field) {
    if (value is! Map) throw FormatException('$field must be an object');
    return Map<String, dynamic>.from(value);
  }

  static Set<String> _readNames(
    Object? value,
    String field, {
    bool permission = false,
  }) {
    if (value == null) return <String>{};
    if (value is! List) throw FormatException('$field must be an array');
    final result = <String>{};
    for (final item in value) {
      if (item is! String ||
          (permission
              ? !PocketPermissionName.isValid(item)
              : !PocketCapabilityName.isValid(item))) {
        throw FormatException('$field contains an invalid name');
      }
      result.add(item);
    }
    return result;
  }
}

/// Backwards-neutral short name for host application code.
typedef GuestManifest = PocketGuestManifest;

final class PocketCapabilityName {
  const PocketCapabilityName._();

  static bool isValid(String value) => _isSafeDottedName(value, maxLength: 128);
}

final class PocketPermissionName {
  const PocketPermissionName._();

  static bool isValid(String value) => _isSafeDottedName(value, maxLength: 64);
}

bool _isSafeDottedName(String value, {required int maxLength}) {
  if (value.isEmpty || value.length > maxLength) return false;
  for (final part in value.split('.')) {
    if (part.isEmpty) return false;
    for (final code in part.codeUnits) {
      final asciiWord =
          (code >= 0x30 && code <= 0x39) ||
          (code >= 0x41 && code <= 0x5a) ||
          (code >= 0x61 && code <= 0x7a) ||
          code == 0x5f ||
          code == 0x2d;
      if (!asciiWord) return false;
    }
  }
  return true;
}
