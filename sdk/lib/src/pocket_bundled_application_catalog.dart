import 'dart:convert';

import 'package:flutter/services.dart';

import 'pocket_config.dart';

/// One application entry from a host-approved, embedded asset catalog.
///
/// The catalog supplies paths and a precomputed launch decision. It never
/// grants native capabilities; those remain in host-owned [PocketAppConfig]
/// policy.
final class PocketBundledApplicationEntry {
  const PocketBundledApplicationEntry({
    required this.appId,
    required this.launchable,
    required this.config,
    required this.workerBytecodeAsset,
    required this.declaresHttpWorker,
  });

  final String appId;
  final bool launchable;
  final PocketAppConfig config;

  /// Resolved from the metadata descriptor's relative bytecode path.
  final String? workerBytecodeAsset;

  /// Whether the bundled Worker descriptor declares an HTTP node. This is a
  /// fact only; a host must still pass an exact origin grant as native policy.
  final bool declaresHttpWorker;
}

/// Parses a generic catalog of compiled applications embedded in a Flutter
/// asset bundle.
///
/// Each `applications` entry uses this data shape:
///
/// ```json
/// {
///   "appId": "example.app",
///   "launchable": true,
///   "assets": {
///     "bytecode": "apps/example/app.qjbc",
///     "pak": "apps/example/app.pak",
///     "metadata": "apps/example/app.bytecode.json",
///     "manifest": "apps/example/guest-manifest.json"
///   }
/// }
/// ```
///
/// Asset paths are relative to the Flutter asset root. [assetPrefix] is
/// prepended once, and every resolved path is checked against traversal and
/// absolute-path forms. Compositor handles are assigned in source order,
/// including entries whose generated `launchable` value is false, so later
/// packages keep stable handles when host compatibility changes.
final class PocketBundledApplicationCatalog {
  const PocketBundledApplicationCatalog._({
    required this.entries,
    required this.launchableEntries,
    required this.applications,
    required this.compositorSurfaces,
  });

  static const empty = PocketBundledApplicationCatalog._(
    entries: <PocketBundledApplicationEntry>[],
    launchableEntries: <PocketBundledApplicationEntry>[],
    applications: <String, PocketAppConfig>{},
    compositorSurfaces: <String, int>{},
  );

  final List<PocketBundledApplicationEntry> entries;
  final List<PocketBundledApplicationEntry> launchableEntries;
  final Map<String, PocketAppConfig> applications;
  final Map<String, int> compositorSurfaces;

  factory PocketBundledApplicationCatalog.fromJson(
    Object? value, {
    required String assetPrefix,
    required int firstCompositorHandle,
    required int lastCompositorHandle,
    Set<String> reservedAppIds = const <String>{},
  }) {
    final document = _object(value, 'bundled application catalog');
    if (document['schemaVersion'] != 1) {
      throw const FormatException(
        'Unsupported bundled application catalog schema',
      );
    }
    final rawApplications = document['applications'];
    if (rawApplications is! List) {
      throw const FormatException(
        'bundled application catalog applications must be an array',
      );
    }
    if (firstCompositorHandle < 2 ||
        lastCompositorHandle > 63 ||
        lastCompositorHandle < firstCompositorHandle) {
      throw const FormatException('Invalid bundled compositor handle range');
    }
    final fixedSurfaces = _integerMap(
      document['fixedCompositorSurfaces'],
      'fixed compositor surfaces',
    );
    final fixedHandles = <int>{};
    for (final entry in fixedSurfaces.entries) {
      if (!_validAppId(entry.key) ||
          entry.value < 2 ||
          entry.value > 63 ||
          (entry.value >= firstCompositorHandle &&
              entry.value <= lastCompositorHandle) ||
          !fixedHandles.add(entry.value)) {
        throw const FormatException('Invalid fixed bundled compositor surface');
      }
    }
    final dynamicCount = rawApplications.length - fixedSurfaces.length;
    if (dynamicCount < 0 ||
        dynamicCount > lastCompositorHandle - firstCompositorHandle + 1) {
      throw const FormatException(
        'Bundled application catalog exceeds its reserved compositor handles',
      );
    }
    final prefix = _assetPrefix(assetPrefix);
    final reserved = <String>{};
    for (final appId in reservedAppIds) {
      if (!_validAppId(appId)) {
        throw FormatException('Invalid reserved application ID: $appId');
      }
      reserved.add(appId);
    }

    final entries = <PocketBundledApplicationEntry>[];
    final ids = <String>{};
    final applications = <String, PocketAppConfig>{};
    final compositorSurfaces = <String, int>{};
    var nextCompositorHandle = firstCompositorHandle;
    for (var index = 0; index < rawApplications.length; index++) {
      final record = _object(
        rawApplications[index],
        'bundled application entry',
      );
      final appId = _requiredString(record, 'appId');
      if (!_validAppId(appId) || !ids.add(appId) || reserved.contains(appId)) {
        throw FormatException(
          'Duplicate, invalid, or reserved bundled application ID: $appId',
        );
      }
      final fixedHandle = fixedSurfaces[appId];
      if (fixedHandle == null && nextCompositorHandle > lastCompositorHandle) {
        throw const FormatException(
          'Bundled application catalog exceeds its reserved compositor handles',
        );
      }
      final compositorHandle = fixedHandle ?? nextCompositorHandle++;
      final launchable = record['launchable'];
      if (launchable is! bool) {
        throw FormatException(
          'bundled application $appId must have a boolean launchable field',
        );
      }
      final assets = _object(record['assets'], 'assets for $appId');
      final bytecodeAsset = _resolvedAsset(
        prefix,
        assets['bytecode'],
        '$appId bytecode',
      );
      final pakAsset = _resolvedAsset(prefix, assets['pak'], '$appId pak');
      final metadataAsset = _resolvedAsset(
        prefix,
        assets['metadata'],
        '$appId metadata',
      );
      final manifestAsset = _resolvedAsset(
        prefix,
        assets['manifest'],
        '$appId manifest',
      );
      final worker = _optionalObject(record['worker'], 'worker for $appId');
      final workerPath = worker == null
          ? null
          : _requiredWorkerPath(worker, '$appId worker');
      final workerBytecodeAsset = workerPath == null
          ? null
          : _resolveRelativeAsset(metadataAsset, workerPath);
      final declaresHttpWorker = worker != null && _declaresHttp(worker);
      final config = PocketAppConfig(
        appId: appId,
        bytecodeAsset: bytecodeAsset,
        pakAsset: pakAsset,
        metadataAsset: metadataAsset,
        manifestAsset: manifestAsset,
      );
      config.validate();
      final entry = PocketBundledApplicationEntry(
        appId: appId,
        launchable: launchable,
        config: config,
        workerBytecodeAsset: workerBytecodeAsset,
        declaresHttpWorker: declaresHttpWorker,
      );
      entries.add(entry);
      if (launchable) {
        applications[appId] = config;
        compositorSurfaces[appId] = compositorHandle;
      }
    }
    final unknownFixedIds = fixedSurfaces.keys
        .where((appId) => !ids.contains(appId))
        .toList(growable: false);
    if (unknownFixedIds.isNotEmpty) {
      throw FormatException(
        'Fixed compositor surfaces reference unknown bundled apps: '
        '${unknownFixedIds.join(', ')}',
      );
    }
    return PocketBundledApplicationCatalog._(
      entries: List<PocketBundledApplicationEntry>.unmodifiable(entries),
      launchableEntries: List<PocketBundledApplicationEntry>.unmodifiable(
        entries.where((entry) => entry.launchable),
      ),
      applications: Map<String, PocketAppConfig>.unmodifiable(applications),
      compositorSurfaces: Map<String, int>.unmodifiable(compositorSurfaces),
    );
  }

  /// Loads a bundled catalog. The caller chooses its asset path, path prefix,
  /// reserved IDs, and compositor range; the SDK supplies no Showcase policy.
  static Future<PocketBundledApplicationCatalog> loadFromBundle(
    String catalogAsset, {
    AssetBundle? bundle,
    required String assetPrefix,
    required int firstCompositorHandle,
    required int lastCompositorHandle,
    Set<String> reservedAppIds = const <String>{},
  }) async {
    final source = await (bundle ?? rootBundle).loadString(catalogAsset);
    return PocketBundledApplicationCatalog.fromJson(
      jsonDecode(source),
      assetPrefix: assetPrefix,
      firstCompositorHandle: firstCompositorHandle,
      lastCompositorHandle: lastCompositorHandle,
      reservedAppIds: reservedAppIds,
    );
  }

  /// Applies host-selected native policy while preserving catalog-owned
  /// asset identity. Policies can only target launchable catalog entries.
  Map<String, PocketAppConfig> applicationsWithNativePolicies({
    Map<String, PocketAppConfig> nativePolicies =
        const <String, PocketAppConfig>{},
  }) {
    final unknown = nativePolicies.keys
        .where((appId) => !applications.containsKey(appId))
        .toList(growable: false);
    if (unknown.isNotEmpty) {
      throw FormatException(
        'Native policy targets an unknown or nonlaunchable bundled app: '
        '${unknown.join(', ')}',
      );
    }
    final result = <String, PocketAppConfig>{};
    for (final entry in launchableEntries) {
      final policy = nativePolicies[entry.appId];
      if (policy == null) {
        result[entry.appId] = entry.config;
        continue;
      }
      if (policy.appId != entry.appId) {
        throw FormatException(
          'Native policy key does not match app ID: ${entry.appId}',
        );
      }
      if (policy.workerHttpOrigins.isNotEmpty && !entry.declaresHttpWorker) {
        throw FormatException(
          'Native worker HTTP policy requires an HTTP Worker descriptor: '
          '${entry.appId}',
        );
      }
      policy.validate();
      result[entry.appId] = entry.config.withNativePolicy(policy);
    }
    return Map<String, PocketAppConfig>.unmodifiable(result);
  }
}

Map<String, Object?> _object(Object? value, String label) {
  if (value is! Map) throw FormatException('$label must be an object');
  return value.map<String, Object?>((key, value) {
    if (key is! String) throw FormatException('$label has a non-string key');
    return MapEntry(key, value);
  });
}

Map<String, Object?>? _optionalObject(Object? value, String label) {
  if (value == null) return null;
  return _object(value, label);
}

Map<String, int> _integerMap(Object? value, String label) {
  if (value == null) return const <String, int>{};
  final record = _object(value, label);
  final result = <String, int>{};
  for (final entry in record.entries) {
    if (entry.value is! int) {
      throw FormatException('$label values must be integers');
    }
    result[entry.key] = entry.value as int;
  }
  return result;
}

String _requiredString(Map<String, Object?> record, String key) {
  final value = record[key];
  if (value is! String || value.trim().isEmpty) {
    throw FormatException('Bundled application field $key must be a string');
  }
  return value.trim();
}

bool _validAppId(String value) =>
    RegExp(r'^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$').hasMatch(value);

String _assetPrefix(String value) {
  final prefix = value.endsWith('/') ? value : '$value/';
  _validateRelativePath(prefix.substring(0, prefix.length - 1), 'asset prefix');
  return prefix;
}

String _resolvedAsset(String prefix, Object? value, String label) {
  if (value is! String || value.trim().isEmpty) {
    throw FormatException('$label must be a non-empty relative asset path');
  }
  final path = value.trim();
  _validateRelativePath(path, label);
  if (path.startsWith(prefix)) {
    throw FormatException('$label already includes the asset prefix: $path');
  }
  return '$prefix$path';
}

String _validateRelativePath(String value, String label) {
  final parts = value.split('/');
  if (value.startsWith('/') ||
      value.contains('\\') ||
      parts.any((part) => part.isEmpty || part == '.' || part == '..')) {
    throw FormatException('Invalid relative asset path for $label: $value');
  }
  return value;
}

String _requiredWorkerPath(Map<String, Object?> worker, String label) {
  final bytecode = _object(worker['bytecode'], '$label bytecode');
  return _validateRelativePath(
    _requiredString(bytecode, 'path'),
    '$label bytecode path',
  );
}

String _resolveRelativeAsset(String metadataAsset, String relativePath) {
  final separator = metadataAsset.lastIndexOf('/');
  final base = separator < 0 ? '' : metadataAsset.substring(0, separator + 1);
  return '$base$relativePath';
}

bool _declaresHttp(Map<String, Object?> worker) {
  final declaration = worker['declaration'];
  if (declaration is! Map) return false;
  final nodes = declaration['nodes'];
  return nodes is List &&
      nodes.any((node) => node is Map && node['kind'] == 'http');
}
