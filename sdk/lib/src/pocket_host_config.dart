import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:crypto/crypto.dart';
import 'package:flutter/foundation.dart';
import 'package:path_provider/path_provider.dart';
import 'package:pocket_flutter/pocket_flutter.dart';

import 'pocket_config.dart';

const _hostConfigMaxBytes = 2 * 1024 * 1024;
const _bootstrapAssetMaxBytes = 16 * 1024 * 1024;
const _bootstrapTotalMaxBytes = 64 * 1024 * 1024;
const _httpRequestTimeout = Duration(seconds: 10);
const _httpBodyTimeout = Duration(seconds: 10);

/// A single host bootstrap document for one Pocket application.
///
/// The document describes the trusted SystemUI package and its mini apps. It
/// does not contain executable code or a second update state machine: each
/// package is converted to the existing [PocketAppConfig] and therefore uses
/// the same signed [PocketUpdateConfig] coordinator when it is opened.
final class PocketHostCatalogEntry {
  const PocketHostCatalogEntry({
    required this.releaseId,
    required this.packageId,
    required this.version,
    required this.build,
    required this.hostConfigUrl,
    required this.rootPayloadSha256,
  });

  final String? releaseId;
  final String? packageId;
  final String? version;
  final int? build;
  final Uri hostConfigUrl;
  final String? rootPayloadSha256;
}

final class PocketHostConfig {
  const PocketHostConfig({
    required this.source,
    required this.systemUI,
    required this.applications,
    required this.hostVersion,
    required this.packageVersion,
    this.catalog = const <PocketHostCatalogEntry>[],
    this.selectedCatalogEntry,
  });

  /// The URL from which this bootstrap document was loaded.
  final Uri source;

  /// The trusted root package and its update configuration.
  final PocketAppConfig systemUI;

  /// Host-approved mini apps indexed by their exact app ID.
  final Map<String, PocketAppConfig> applications;

  /// Host version segment used by the canonical update layout.
  final String hostVersion;

  /// Package version segment used by this bootstrap document. The signed
  /// payload remains authoritative for semantic version/build admission.
  final String packageVersion;

  /// Immutable root release records exposed by the fixed package index.
  /// Records are only used to bind a refreshed catalog to the mounted signed
  /// root payload; they do not replace the signed update coordinator.
  final List<PocketHostCatalogEntry> catalog;

  /// The descriptor selected for this host document, normally `latest` or the
  /// version whose root payload hash matched a mounted generation.
  final PocketHostCatalogEntry? selectedCatalogEntry;

  String? get rootPayloadSha256 => selectedCatalogEntry?.rootPayloadSha256;

  /// Parse the SDK host bootstrap schema emitted by the Editor.
  ///
  /// The stable fields are intentionally small:
  ///
  /// ```json
  /// {
  ///   "schemaVersion": 1,
  ///   "kind": "pocket-editor-app-host",
  ///   "updates": {"baseUrl": "http://192.168.1.2:8791/test",
  ///     "hostVersion": "0.1.0", "packageVersion": "0.1.0",
  ///     "keyId": "...", "publicKey": "..."},
  ///   "release": {"routeVersion": "0.1.0-test.3"},
  ///   "systemUI": "pocket.host.demo",
  ///   "applications": {"pocket.host.demo": {...}, "mini.app": {...}}
  /// }
  /// ```
  ///
  /// The Editor's `updates.packageVersion` is signed compatibility/admission
  /// metadata used by the existing updater; it is not a URL segment. The
  /// fixed `latest.json` package index selects the current immutable signed
  /// manifest on every check. `release.routeVersion` is only the immutable
  /// historical host descriptor identifier. No child URL is supplied by the
  /// caller: every package derives its own fixed index endpoint from the same
  /// update tuple.
  factory PocketHostConfig.fromJson(
    Map<String, dynamic> json, {
    Uri? source,
    Set<String> allowInsecureHttpHosts = const <String>{},
    List<PocketHostCatalogEntry> catalog = const <PocketHostCatalogEntry>[],
    PocketHostCatalogEntry? selectedCatalogEntry,
    Uri? packageIndexSource,
  }) {
    final schema = _integer(json, 'schemaVersion', required: false) ?? 1;
    if (schema != 1 || json['kind'] != 'pocket-editor-app-host') {
      throw const FormatException('Unsupported Pocket host config schema');
    }
    final sourceUri = source ?? _uri(json['source']);
    final updates = _object(json['updates'], 'updates');
    final baseUrl =
        _string(updates, 'baseUrl') ??
        (sourceUri == null ? null : _origin(sourceUri));
    final hostVersion = _string(updates, 'hostVersion');
    final updatePackageVersion = _string(updates, 'packageVersion');
    final release = _object(json['release'], 'release');
    // `release.routeVersion` identifies this immutable host.json history
    // entry. It must not leak into update manifests: the public package slot
    // is the compatibility branch declared by `updates.packageVersion`.
    if (_string(release, 'routeVersion') == null) {
      throw const FormatException(
        'Pocket host config requires release.routeVersion',
      );
    }
    final packageVersion = updatePackageVersion;
    if (baseUrl == null || hostVersion == null || packageVersion == null) {
      throw const FormatException(
        'Pocket host config requires baseUrl, hostVersion and packageVersion',
      );
    }
    final base = Uri.tryParse(baseUrl);
    if (base == null ||
        !base.hasScheme ||
        base.host.isEmpty ||
        base.userInfo.isNotEmpty ||
        base.hasQuery ||
        base.hasFragment ||
        (base.scheme != 'https' && !_allowHttp(base, allowInsecureHttpHosts))) {
      throw const FormatException('Pocket host config has an unsafe baseUrl');
    }
    if (sourceUri != null &&
        (base.scheme != sourceUri.scheme ||
            base.host != sourceUri.host ||
            base.port != sourceUri.port)) {
      throw const FormatException(
        'Pocket host config baseUrl must use the host config origin',
      );
    }
    final keyId = _string(updates, 'keyId') ?? '';
    final publicKey = _string(updates, 'publicKey') ?? '';
    final namespace = _string(updates, 'namespace') ?? 'default';
    final debugHosts = _approvedDebugHosts(
      _stringSet(updates['debugHttpHosts']),
      allowInsecureHttpHosts,
    );
    if (base.scheme == 'http' && allowInsecureHttpHosts.contains(base.host)) {
      debugHosts.add(base.host);
    }
    final rootIdHint = _string(json, 'systemUI');
    if (rootIdHint == null) {
      throw const FormatException('Pocket host config is missing systemUI');
    }
    final applications = _object(json['applications'], 'applications');
    final root = _packageMap(applications[rootIdHint]);
    if (root == null) {
      throw const FormatException(
        'Pocket host config is missing its root package',
      );
    }
    final rootId = rootIdHint;
    final common = _updateConfig(
      json,
      updates: updates,
      baseUrl: base.toString(),
      hostVersion: hostVersion,
      packageVersion: packageVersion,
      keyId: keyId,
      publicKey: publicKey,
      namespace: namespace,
      debugHosts: debugHosts,
      indexUrl: packageIndexSource == null
          ? ''
          : _fixedIndexUri(packageIndexSource, rootId).toString(),
    );
    final system = _toAppConfig(root, rootId, common, root: true);
    final apps = <String, PocketAppConfig>{};
    for (final entry in applications.entries) {
      final package = _packageMap(entry.value);
      if (package == null) {
        throw FormatException(
          'Pocket host application ${entry.key} is invalid',
        );
      }
      final appId = _string(package, 'appId') ?? entry.key;
      if (appId.isEmpty) {
        throw const FormatException('Pocket host application is missing appId');
      }
      if (appId == rootId) continue;
      if (apps.containsKey(appId)) {
        throw FormatException('Duplicate Pocket host package: $appId');
      }
      apps[appId] = _toAppConfig(package, appId, common);
    }
    final configuredSurfaces = _integerMap(json['compositorSurfaces']);
    final decoratedSystem = configuredSurfaces.isEmpty
        ? system
        : PocketAppConfig(
            appId: system.appId,
            bytecodeAsset: system.bytecodeAsset,
            pakAsset: system.pakAsset,
            metadataAsset: system.metadataAsset,
            manifestAsset: system.manifestAsset,
            updates: system.updates,
            downloadOnOpen: system.downloadOnOpen,
            showFps: system.showFps,
            allowedPermissions: system.allowedPermissions,
            pluginFactories: system.pluginFactories,
            additionalCapabilities: system.additionalCapabilities,
            recordingFactory: system.recordingFactory,
            compositorSurfaces: configuredSurfaces,
            workerHttpOrigins: system.workerHttpOrigins,
            offloadProviderFactory: system.offloadProviderFactory,
            memoryLimits: system.memoryLimits,
            bootstrapMetadataJson: system.bootstrapMetadataJson,
            bootstrapManifestJson: system.bootstrapManifestJson,
          );
    decoratedSystem.validate();
    for (final config in apps.values) {
      config.validate();
    }
    return PocketHostConfig(
      source: sourceUri ?? base,
      systemUI: decoratedSystem,
      applications: Map<String, PocketAppConfig>.unmodifiable(apps),
      hostVersion: hostVersion,
      packageVersion: packageVersion,
      catalog: List<PocketHostCatalogEntry>.unmodifiable(catalog),
      selectedCatalogEntry: selectedCatalogEntry,
    );
  }

  /// Fetch and parse one host document before constructing `runApp`.
  ///
  /// Redirects are rejected so a LAN bootstrap URL cannot silently move the
  /// trust boundary to another host. Manifest signatures remain the authority
  /// for every subsequent package update.
  static Future<PocketHostConfig> load(
    Uri uri, {
    HttpClient? client,
    Set<String> allowInsecureHttpHosts = const <String>{},
    Directory? trustAnchorDirectory,
    String? requiredRootPayloadSha256,
  }) async {
    final parsed = uri;
    final effectiveAllowedHosts = <String>{
      ...allowInsecureHttpHosts,
      if (kDebugMode && parsed.scheme == 'http') parsed.host,
    };
    final allowHttp = _allowHttp(parsed, effectiveAllowedHosts);
    if (parsed.scheme != 'https' && !allowHttp) {
      throw const FormatException(
        'Pocket host bootstrap requires HTTPS or an explicitly allowed debug LAN host',
      );
    }
    final owned = client == null;
    final http = client ?? HttpClient();
    try {
      final index = await _fetchJsonObject(
        http,
        parsed,
        errorLabel: 'Pocket host config',
      );
      final resolved = await _resolveHostDocument(
        index,
        client: http,
        source: parsed,
        allowedHttpHosts: effectiveAllowedHosts,
        requiredRootPayloadSha256: requiredRootPayloadSha256,
      );
      final document = resolved.document;
      await _hydrateBootstrapAssets(
        document,
        client: http,
        source: parsed,
        baseUri: resolved.baseUri,
        allowedHttpHosts: effectiveAllowedHosts,
      );
      final loaded = PocketHostConfig.fromJson(
        document,
        source: parsed,
        allowInsecureHttpHosts: effectiveAllowedHosts,
        catalog: resolved.catalog,
        selectedCatalogEntry: resolved.selectedCatalogEntry,
        packageIndexSource: resolved.isIndex ? parsed : null,
      );
      await _checkTrustAnchor(
        loaded,
        directory:
            trustAnchorDirectory ?? await getApplicationSupportDirectory(),
      );
      return loaded;
    } finally {
      if (owned) http.close(force: true);
    }
  }

  /// Load the single host URL supplied at Flutter build time.
  ///
  /// An empty value returns `null`, allowing existing explicit
  /// `PocketAppConfig` consumers to remain source-compatible. The URL is the
  /// only required input; child package endpoints are derived from the
  /// returned document and are never read from separate environment fields.
  static Future<PocketHostConfig?> loadFromEnvironment({
    String? requiredRootPayloadSha256,
  }) {
    const raw = String.fromEnvironment('POCKET_HOST_CONFIG_URL');
    if (raw.isEmpty) return Future<PocketHostConfig?>.value(null);
    final uri = Uri.tryParse(raw);
    if (uri == null) {
      return Future<PocketHostConfig?>.error(
        const FormatException('POCKET_HOST_CONFIG_URL is not a valid URL'),
      );
    }
    return load(uri, requiredRootPayloadSha256: requiredRootPayloadSha256);
  }

  /// Creates a `PocketSystemHost` using all packages from this document.
  /// The widget remains the existing runtime and update coordinator.
  Map<String, PocketAppConfig> get hostApplications => applications;
}

PocketUpdateConfig _updateConfig(
  Map<String, dynamic> json, {
  required Map<String, dynamic> updates,
  required String baseUrl,
  required String hostVersion,
  required String packageVersion,
  required String keyId,
  required String publicKey,
  required String namespace,
  required Set<String> debugHosts,
  required String indexUrl,
}) {
  final trustRootKeyId =
      _string(updates, 'trustRootKeyId') ?? _string(json, 'trustRootKeyId');
  final trustRootPublicKey =
      _string(updates, 'trustRootPublicKey') ??
      _string(json, 'trustRootPublicKey');
  final trustPolicyUrl =
      _string(updates, 'trustPolicyUrl') ?? _string(json, 'trustPolicyUrl');
  return PocketUpdateConfig(
    baseUrl: baseUrl,
    hostVersion: hostVersion,
    packageVersion: packageVersion,
    keyId: keyId,
    publicKey: publicKey,
    namespace: namespace,
    trustRootKeyId: trustRootKeyId,
    trustRootPublicKey: trustRootPublicKey,
    trustPolicyUrl: trustPolicyUrl,
    indexUrl: indexUrl,
    debugHttpHosts: debugHosts.toList(growable: false),
  );
}

PocketAppConfig _toAppConfig(
  Map<String, dynamic> value,
  String appId,
  PocketUpdateConfig common, {
  bool root = false,
}) {
  // The aggregate document carries one routing tuple, but each signed
  // package may have its own release key/namespace. Keep those package facts
  // from the verified descriptor while retaining the fixed host/package
  // branch from the root `updates` object. In particular, never use a
  // descriptor's immutable release id as the routing packageVersion.
  final updates = _packageUpdateConfig(value, common, appId);
  return PocketAppConfig(
    appId: appId,
    bytecodeAsset: root ? 'assets/app.qjbc' : 'assets/apps/$appId/app.qjbc',
    pakAsset: root ? 'assets/app.pak' : 'assets/apps/$appId/app.pak',
    metadataAsset: root
        ? 'assets/app.bytecode.json'
        : 'assets/apps/$appId/app.bytecode.json',
    manifestAsset: root
        ? 'assets/guest-manifest.json'
        : 'assets/apps/$appId/guest-manifest.json',
    updates: updates,
    // A fixed package index has no valid embedded fallback: the descriptor's
    // signed package is the root identity and must be admitted before the
    // SystemUI starts. Legacy direct host documents retain their historical
    // explicit/default behavior.
    downloadOnOpen: common.indexUrl.isNotEmpty
        ? true
        : (_boolean(value, 'downloadOnOpen') ?? !root),
    // Permissions, capabilities, compositor handles and memory limits are
    // native-approved policy. A remote host document can select package bytes
    // but cannot grant itself new authority.
    memoryLimits: const PocketMemoryLimits(),
    bootstrapMetadataJson: _string(value, 'bootstrapMetadataJson'),
    bootstrapManifestJson: _string(value, 'bootstrapManifestJson'),
  );
}

PocketUpdateConfig _packageUpdateConfig(
  Map<String, dynamic> value,
  PocketUpdateConfig common,
  String appId,
) {
  final declaredKeyId = _string(value, 'keyId');
  final declaredPublicKey = _string(value, 'publicKey');
  if (common.indexUrl.isNotEmpty &&
      ((declaredKeyId != null && declaredKeyId != common.keyId) ||
          (declaredPublicKey != null &&
              declaredPublicKey != common.publicKey))) {
    throw const FormatException(
      'Fixed package index does not permit a child release key different from the pinned root key',
    );
  }
  final namespace = common.indexUrl.isEmpty
      ? (_string(value, 'namespace') ?? common.namespace)
      : _stableIndexNamespace(common.indexUrl, appId);
  return PocketUpdateConfig(
    baseUrl: common.baseUrl,
    hostVersion: common.hostVersion,
    packageVersion: common.packageVersion,
    keyId: common.indexUrl.isEmpty
        ? (declaredKeyId ?? common.keyId)
        : common.keyId,
    publicKey: common.indexUrl.isEmpty
        ? (declaredPublicKey ?? common.publicKey)
        : common.publicKey,
    namespace: namespace,
    trustRootKeyId: common.trustRootKeyId,
    trustRootPublicKey: common.trustRootPublicKey,
    trustPolicyUrl: common.trustPolicyUrl,
    indexUrl: common.indexUrl.isEmpty
        ? ''
        : _fixedIndexUri(Uri.parse(common.indexUrl), appId).toString(),
    debugHttpHosts: common.debugHttpHosts,
  );
}

Map<String, dynamic>? _packageMap(dynamic value, {String? fallbackAppId}) {
  if (value is! Map) return null;
  final result = Map<String, dynamic>.from(value);
  if (!result.containsKey('appId') && fallbackAppId != null) {
    result['appId'] = fallbackAppId;
  }
  return result;
}

Map<String, dynamic> _object(dynamic value, String field) {
  if (value is! Map) {
    throw FormatException('Pocket host config field $field must be an object');
  }
  return Map<String, dynamic>.from(value);
}

Set<String> _approvedDebugHosts(Set<String> declared, Set<String> allowed) =>
    declared.intersection(allowed);

Future<void> _hydrateBootstrapAssets(
  Map<String, dynamic> document, {
  required HttpClient client,
  required Uri source,
  required Uri baseUri,
  required Set<String> allowedHttpHosts,
}) async {
  final applications = _object(document['applications'], 'applications');
  var totalBytes = 0;
  for (final entry in applications.entries) {
    final package = _packageMap(entry.value);
    if (package == null) {
      throw FormatException('Pocket host application ${entry.key} is invalid');
    }
    // Inline bootstrap values are not trusted input. They are populated only
    // below, after the declared bytes pass the host-origin/hash/size checks.
    package.remove('bootstrapMetadataJson');
    package.remove('bootstrapManifestJson');
    final rawAssets = package['bootstrapAssets'];
    if (rawAssets is! Map) {
      throw FormatException(
        'Pocket host application ${entry.key} is missing bootstrapAssets',
      );
    }
    var metadataVerified = false;
    var manifestVerified = false;
    for (final assetEntry in rawAssets.entries) {
      final descriptor = _object(
        assetEntry.value,
        'bootstrapAssets.${assetEntry.key}',
      );
      final urlValue = _string(descriptor, 'url');
      final expectedHash = _string(descriptor, 'sha256');
      final expectedSize = _integer(descriptor, 'size', required: true);
      if (urlValue == null || expectedHash == null || expectedSize == null) {
        throw FormatException('Invalid bootstrap asset ${assetEntry.key}');
      }
      if (!RegExp(r'^[0-9a-fA-F]{64}$').hasMatch(expectedHash)) {
        throw FormatException('Invalid bootstrap asset hash ${assetEntry.key}');
      }
      if (expectedSize <= 0 || expectedSize > _bootstrapAssetMaxBytes) {
        throw FormatException(
          'Invalid bootstrap asset size ${assetEntry.key}: $expectedSize',
        );
      }
      if (totalBytes > _bootstrapTotalMaxBytes - expectedSize) {
        throw const FormatException(
          'Pocket host bootstrap assets exceed the total size limit',
        );
      }
      final uri = _resolveSameOriginUri(
        baseUri,
        urlValue,
        source: source,
        allowedHttpHosts: allowedHttpHosts,
        label: 'Bootstrap asset',
      );
      final bytes = await _fetchBytes(client, uri, maxBytes: expectedSize);
      totalBytes += bytes.length;
      if (bytes.length != expectedSize ||
          sha256.convert(bytes).toString().toLowerCase() !=
              expectedHash.toLowerCase()) {
        throw FormatException(
          'Bootstrap asset verification failed: ${assetEntry.key}',
        );
      }
      final name = assetEntry.key.toString();
      if (name.endsWith('app.bytecode.json')) {
        package['bootstrapMetadataJson'] = utf8.decode(bytes);
        metadataVerified = true;
      } else if (name.endsWith('guest-manifest.json')) {
        package['bootstrapManifestJson'] = utf8.decode(bytes);
        manifestVerified = true;
      }
    }
    if (!metadataVerified || !manifestVerified) {
      throw FormatException(
        'Pocket host application ${entry.key} is missing verified bootstrap metadata or manifest',
      );
    }
    applications[entry.key] = package;
  }
  document['applications'] = applications;
}

/// The fixed App URL is a journal-derived package index. It is deliberately
/// not an update envelope: the index chooses one immutable host descriptor,
/// and that descriptor owns the complete root/mini-app bootstrap catalog.
/// Keeping the caller URL separate from [baseUri] also keeps trust pinning
/// scoped to the URL the user entered rather than a body-controlled URL.
Future<_ResolvedHostDocument> _resolveHostDocument(
  Map<String, dynamic> index, {
  required HttpClient client,
  required Uri source,
  required Set<String> allowedHttpHosts,
  String? requiredRootPayloadSha256,
}) async {
  if (index['kind'] != 'pocket-editor-package-index') {
    return _ResolvedHostDocument(
      document: index,
      baseUri: source,
      catalog: const <PocketHostCatalogEntry>[],
      selectedCatalogEntry: null,
      isIndex: false,
    );
  }
  final schema = _integer(index, 'schemaVersion', required: false) ?? 1;
  if (schema != 1) {
    throw const FormatException('Unsupported Pocket package index schema');
  }
  final latest = _object(index['latest'], 'latest');
  final latestEntry = _catalogEntry(index, latest, source, allowedHttpHosts);
  final rawVersions = index['versions'];
  final entries = <PocketHostCatalogEntry>[latestEntry];
  if (rawVersions != null) {
    if (rawVersions is! List) {
      throw const FormatException(
        'Pocket package index versions must be an array',
      );
    }
    for (final raw in rawVersions) {
      if (raw is! Map) {
        throw const FormatException('Pocket package index version is invalid');
      }
      final entry = _catalogEntry(
        index,
        Map<String, dynamic>.from(raw),
        source,
        allowedHttpHosts,
      );
      if (!entries.any(
        (candidate) =>
            candidate.hostConfigUrl == entry.hostConfigUrl &&
            candidate.rootPayloadSha256 == entry.rootPayloadSha256,
      )) {
        entries.add(entry);
      }
    }
  }
  final expectedHash = requiredRootPayloadSha256?.toLowerCase();
  PocketHostCatalogEntry? selected;
  if (expectedHash == null) {
    selected = latestEntry;
  } else {
    for (final entry in entries) {
      if (entry.rootPayloadSha256?.toLowerCase() == expectedHash) {
        selected = entry;
        break;
      }
    }
  }
  if (selected == null) {
    throw const FormatException(
      'Pocket package index has no descriptor for the mounted root payload',
    );
  }
  final descriptorUri = selected.hostConfigUrl;
  final descriptor = await _fetchJsonObject(
    client,
    descriptorUri,
    errorLabel: 'Pocket host descriptor',
  );
  if (descriptor['kind'] != 'pocket-editor-app-host') {
    throw const FormatException(
      'Pocket package index descriptor is not a host config',
    );
  }
  final expectedRoot =
      _string(index, 'systemUI') ?? _string(index, 'rootAppId');
  if (expectedRoot != null && descriptor['systemUI'] != expectedRoot) {
    throw const FormatException(
      'Pocket package index and host descriptor select different SystemUI apps',
    );
  }
  final expectedPayload = selected.rootPayloadSha256;
  if (expectedPayload != null) {
    final applications = _object(descriptor['applications'], 'applications');
    final rootId = _string(descriptor, 'systemUI');
    final root = rootId == null ? null : _packageMap(applications[rootId]);
    final actualPayload =
        (root == null ? null : _string(root, 'payloadSha256')) ??
        _string(descriptor, 'rootPayloadSha256');
    if (actualPayload == null ||
        actualPayload.toLowerCase() != expectedPayload.toLowerCase()) {
      throw const FormatException(
        'Pocket package index does not match the immutable root descriptor',
      );
    }
  }
  return _ResolvedHostDocument(
    document: descriptor,
    baseUri: descriptorUri,
    catalog: entries,
    selectedCatalogEntry: selected,
    isIndex: true,
  );
}

PocketHostCatalogEntry _catalogEntry(
  Map<String, dynamic> index,
  Map<String, dynamic> value,
  Uri source,
  Set<String> allowedHttpHosts,
) {
  final descriptorValue =
      _string(value, 'hostConfigUrl') ?? _string(value, 'descriptorUrl');
  if (descriptorValue == null) {
    throw const FormatException(
      'Pocket package index is missing its immutable host descriptor',
    );
  }
  final hostConfigUrl = _resolveSameOriginUri(
    source,
    descriptorValue,
    source: source,
    allowedHttpHosts: allowedHttpHosts,
    label: 'Pocket host descriptor',
  );
  final rootHash =
      _string(value, 'rootPayloadSha256') ?? _string(value, 'payloadSha256');
  if (rootHash != null && !RegExp(r'^[0-9a-fA-F]{64}$').hasMatch(rootHash)) {
    throw const FormatException(
      'Pocket package index root payload hash is invalid',
    );
  }
  return PocketHostCatalogEntry(
    releaseId: _string(value, 'releaseId'),
    packageId:
        _string(value, 'packageId') ??
        _string(value, 'id') ??
        _string(index, 'packageId'),
    version: _string(value, 'version'),
    build: _integer(value, 'build', required: false),
    hostConfigUrl: hostConfigUrl,
    rootPayloadSha256: rootHash,
  );
}

Future<Map<String, dynamic>> _fetchJsonObject(
  HttpClient client,
  Uri uri, {
  required String errorLabel,
}) async {
  final response = await _openHttpResponse(client, uri);
  if (response.statusCode != HttpStatus.ok) {
    throw HttpException(
      '$errorLabel request failed: ${response.statusCode}',
      uri: uri,
    );
  }
  final body = utf8.decode(
    await _readHttpBytes(response, uri: uri, maxBytes: _hostConfigMaxBytes),
  );
  final value = jsonDecode(body);
  if (value is! Map) {
    throw FormatException('$errorLabel must be a JSON object');
  }
  return Map<String, dynamic>.from(value);
}

Uri _resolveSameOriginUri(
  Uri baseUri,
  String value, {
  required Uri source,
  required Set<String> allowedHttpHosts,
  required String label,
}) {
  final parsed = Uri.tryParse(value);
  if (parsed == null) {
    throw FormatException('$label URL is invalid: $value');
  }
  final resolved = parsed.hasScheme ? parsed : baseUri.resolve(value);
  if (resolved.userInfo.isNotEmpty ||
      resolved.host != source.host ||
      resolved.port != source.port ||
      resolved.scheme != source.scheme ||
      (resolved.scheme != 'https' && !_allowHttp(resolved, allowedHttpHosts))) {
    throw FormatException('$label URL is outside the host config: $value');
  }
  return resolved;
}

final class _ResolvedHostDocument {
  const _ResolvedHostDocument({
    required this.document,
    required this.baseUri,
    required this.catalog,
    required this.selectedCatalogEntry,
    required this.isIndex,
  });

  final Map<String, dynamic> document;
  final Uri baseUri;
  final List<PocketHostCatalogEntry> catalog;
  final PocketHostCatalogEntry? selectedCatalogEntry;
  final bool isIndex;
}

Future<List<int>> _fetchBytes(
  HttpClient client,
  Uri uri, {
  required int maxBytes,
}) async {
  final response = await _openHttpResponse(client, uri);
  if (response.statusCode != HttpStatus.ok) {
    throw HttpException(
      'Bootstrap asset request failed: ${response.statusCode}',
      uri: uri,
    );
  }
  return _readHttpBytes(response, uri: uri, maxBytes: maxBytes);
}

Future<HttpClientResponse> _openHttpResponse(HttpClient client, Uri uri) async {
  HttpClientRequest? request;
  try {
    request = await client.getUrl(uri).timeout(_httpRequestTimeout);
    request.followRedirects = false;
    return await request.close().timeout(_httpRequestTimeout);
  } on TimeoutException {
    request?.abort();
    throw HttpException('HTTP request timed out', uri: uri);
  }
}

Future<List<int>> _readHttpBytes(
  HttpClientResponse response, {
  required Uri uri,
  required int maxBytes,
}) async {
  if (maxBytes < 0) {
    throw const FormatException('HTTP body size limit must not be negative');
  }
  final contentLength = response.contentLength;
  if (contentLength > maxBytes) {
    throw FormatException(
      'HTTP body exceeds the size limit for $uri: $contentLength > $maxBytes',
    );
  }
  final iterator = StreamIterator<List<int>>(response);
  final bytes = BytesBuilder(copy: false);
  var length = 0;
  try {
    while (await iterator.moveNext().timeout(_httpBodyTimeout)) {
      final chunk = iterator.current;
      if (chunk.length > maxBytes - length) {
        throw FormatException('HTTP body exceeds the size limit for $uri');
      }
      bytes.add(chunk);
      length += chunk.length;
    }
    return bytes.takeBytes();
  } on TimeoutException {
    throw HttpException('HTTP body timed out', uri: uri);
  } finally {
    await iterator.cancel().timeout(_httpRequestTimeout, onTimeout: () {});
  }
}

/// Pins the first trust anchor accepted for the caller's exact host URL.
///
/// Policy mode stores the host-owned root anchor and may rotate release keys
/// through the existing signed policy coordinator. Legacy mode stores the
/// release key itself. The URL is the caller-provided scope; no identity or
/// version field from the fetched JSON can create a new trust namespace.
Future<void> _checkTrustAnchor(
  PocketHostConfig config, {
  required Directory directory,
}) async {
  final updates = config.systemUI.updates;
  if (updates == null || !updates.configured) {
    return;
  }
  final policyMode = updates.trustPolicyConfigured;
  if (!policyMode && (updates.keyId.isEmpty || updates.publicKey.isEmpty)) {
    throw const FormatException(
      'Pocket host update configuration has no initial trust key',
    );
  }
  // Query strings are transport selectors, not trust namespaces. Keep the
  // caller-owned route path (including its host/package branch) while making
  // `?x=...` unable to mint a second anchor for the same host URL.
  final scope = config.source.replace(query: null, fragment: null).toString();
  final file = File('${directory.path}/pocket-host-trust.json');
  Map<String, dynamic> document = <String, dynamic>{
    'schemaVersion': 1,
    'anchors': <String, dynamic>{},
  };
  if (await file.exists()) {
    final decoded = jsonDecode(await file.readAsString());
    if (decoded is! Map || decoded['schemaVersion'] != 1) {
      throw const FormatException('Pocket host trust anchor is invalid');
    }
    final rawAnchors = decoded['anchors'];
    if (rawAnchors is! Map) {
      throw const FormatException('Pocket host trust anchor is invalid');
    }
    document = Map<String, dynamic>.from(decoded);
  }
  final anchors = Map<String, dynamic>.from(document['anchors'] as Map);
  final current = anchors[scope];
  final key = <String, dynamic>{
    'mode': policyMode ? 'policy' : 'release',
    'systemUI': config.systemUI.appId,
    'hostVersion': config.hostVersion,
    if (policyMode) ...<String, String>{
      'rootKeyId': updates.trustRootKeyId!,
      'rootPublicKey': updates.trustRootPublicKey!,
      'policyUrl': updates.trustPolicyUrl!,
    } else ...<String, String>{
      'keyId': updates.keyId,
      'publicKey': updates.publicKey,
    },
  };
  if (current != null) {
    if (current is! Map ||
        current['mode'] != key['mode'] ||
        current['systemUI'] != key['systemUI'] ||
        current['hostVersion'] != key['hostVersion'] ||
        (policyMode
            ? current['rootKeyId'] != key['rootKeyId'] ||
                  current['rootPublicKey'] != key['rootPublicKey'] ||
                  current['policyUrl'] != key['policyUrl']
            : current['keyId'] != key['keyId'] ||
                  current['publicKey'] != key['publicKey'])) {
      throw const FormatException(
        'Pocket host trust anchor changed for the existing host URL',
      );
    }
    return;
  }
  anchors[scope] = key;
  document['anchors'] = anchors;
  await directory.create(recursive: true);
  final temporary = File(
    '${file.path}.tmp-${DateTime.now().microsecondsSinceEpoch}',
  );
  await temporary.writeAsString(jsonEncode(document), flush: true);
  try {
    await temporary.rename(file.path);
  } catch (_) {
    if (await temporary.exists()) await temporary.delete();
    rethrow;
  }
}

String? _string(Map<String, dynamic> value, String key) {
  final item = value[key];
  return item is String && item.isNotEmpty ? item : null;
}

int? _integer(
  Map<String, dynamic> value,
  String key, {
  required bool required,
}) {
  final item = value[key];
  if (item == null && !required) return null;
  if (item is int) return item;
  if (item is num && item == item.roundToDouble()) return item.toInt();
  throw FormatException('Pocket host config field $key must be an integer');
}

bool? _boolean(Map<String, dynamic> value, String key) {
  final item = value[key];
  if (item == null) return null;
  if (item is bool) return item;
  throw FormatException('Pocket host config field $key must be a boolean');
}

Set<String> _stringSet(dynamic value) {
  if (value == null) return <String>{};
  if (value is String) return value.isEmpty ? <String>{} : <String>{value};
  if (value is! List || value.any((item) => item is! String || item.isEmpty)) {
    throw const FormatException('Pocket host config string list is invalid');
  }
  return value.cast<String>().toSet();
}

Map<String, int> _integerMap(dynamic value) {
  if (value == null) return <String, int>{};
  if (value is! Map)
    throw const FormatException('Pocket host config map is invalid');
  final result = <String, int>{};
  for (final entry in value.entries) {
    final key = entry.key;
    final item = entry.value;
    if (key is! String || item is! int) {
      throw const FormatException('Pocket host config map value is invalid');
    }
    result[key] = item;
  }
  return result;
}

Uri? _uri(dynamic value) => value is String ? Uri.tryParse(value) : null;

Uri _fixedIndexUri(Uri source, String packageId) {
  final segments = source.pathSegments;
  final pocket = segments.indexOf('pocket');
  if (pocket < 0 || segments.length < pocket + 4) {
    throw const FormatException(
      'Pocket host source must be a canonical package index URL',
    );
  }
  final hostVersion = segments[pocket + 1];
  if (hostVersion.isEmpty || segments.last != 'latest.json') {
    throw const FormatException(
      'Pocket host source must end in /pocket/<hostVersion>/<package>/latest.json',
    );
  }
  return source.replace(
    pathSegments: <String>[
      ...segments.take(pocket + 1),
      hostVersion,
      packageId,
      'latest.json',
    ],
    query: null,
    fragment: null,
  );
}

String _stableIndexNamespace(String indexUrl, String appId) {
  final source = Uri.parse(
    indexUrl,
  ).replace(query: null, fragment: null).toString();
  final digest = sha256.convert(utf8.encode('$source\n$appId')).toString();
  return 'host_${digest.substring(0, 24)}';
}

String _origin(Uri uri) =>
    uri.replace(path: '', query: null, fragment: null).toString();

bool _allowHttp(Uri uri, Set<String> allowed) {
  if (uri.scheme != 'http') return false;
  if (uri.host == '127.0.0.1' || uri.host == 'localhost' || uri.host == '::1') {
    return kDebugMode;
  }
  return kDebugMode && allowed.contains(uri.host);
}
