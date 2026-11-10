import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:isolate';
import 'dart:typed_data';

import 'package:crypto/crypto.dart';
import 'package:flutter/foundation.dart';
import 'package:path_provider/path_provider.dart';
import 'package:pocket_flutter/pocket_flutter.dart';
import 'package:pocket_services/pocket_services.dart';

import 'pocket_config.dart';

const _hostConfigMaxBytes = 2 * 1024 * 1024;
const _bootstrapAssetMaxBytes = 16 * 1024 * 1024;
const _bootstrapTotalMaxBytes = 64 * 1024 * 1024;
const _hostCacheMaxEntries = 16;
const _hostCacheMaxFileBytes =
    _bootstrapTotalMaxBytes + (4 * _hostConfigMaxBytes);
const _httpRequestTimeout = Duration(seconds: 10);
const _httpBodyTimeout = Duration(seconds: 10);
int _atomicWriteSequence = 0;

/// Observed bytes while the host bootstrap document and its required assets
/// are read. [totalBytes] is null when the response has no declared length;
/// bootstrap assets use the declared size that is verified after reading.
@immutable
final class PocketHostLoadProgress {
  const PocketHostLoadProgress({
    required this.stage,
    required this.downloadedBytes,
    required this.totalBytes,
  });

  /// `index`, `descriptor`, or `bootstrapAsset`.
  final String stage;

  /// Bytes read from the current HTTP response body.
  final int downloadedBytes;

  /// Known response length, or null when the server did not provide one.
  final int? totalBytes;
}

/// Receives progress facts from actual bootstrap HTTP response chunks.
typedef PocketHostLoadProgressCallback =
    void Function(PocketHostLoadProgress progress);

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
    final normalizedAllowedHosts = _normalizeHosts(allowInsecureHttpHosts);
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
        (base.scheme != 'https' && !_allowHttp(base, normalizedAllowedHosts))) {
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
      normalizedAllowedHosts,
    );
    if (base.scheme == 'http' && normalizedAllowedHosts.contains(base.host)) {
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
    bool cacheFirst = false,
    PocketHostLoadProgressCallback? onProgress,
    PocketCancellationToken? cancellation,
  }) async {
    cancellation?.throwIfCancelled();
    final parsed = uri;
    final effectiveAllowedHosts = _normalizeHosts(<String>{
      ...allowInsecureHttpHosts,
      if (kDebugMode && parsed.scheme == 'http') parsed.host,
    });
    final allowHttp = _allowHttp(parsed, effectiveAllowedHosts);
    if (parsed.scheme != 'https' && !allowHttp) {
      throw const FormatException(
        'Pocket host bootstrap requires HTTPS or an explicitly allowed HTTP host',
      );
    }
    Directory? resolvedTrustDirectory = trustAnchorDirectory;
    Future<Directory> getTrustDirectory() async {
      final existing = resolvedTrustDirectory;
      if (existing != null) return existing;
      final resolved = await _awaitCancellable(
        getApplicationSupportDirectory(),
        cancellation,
      );
      resolvedTrustDirectory = resolved;
      return resolved;
    }

    if (cacheFirst) {
      cancellation?.throwIfCancelled();
      final trustDirectory = await getTrustDirectory();
      cancellation?.throwIfCancelled();
      final cached = await _tryLoadCachedHostConfig(
        parsed,
        allowedHttpHosts: effectiveAllowedHosts,
        trustDirectory: trustDirectory,
        requiredRootPayloadSha256: requiredRootPayloadSha256,
        cancellation: cancellation,
      );
      cancellation?.throwIfCancelled();
      if (cached != null) return cached;
    }
    final owned = client == null;
    final http = client ?? HttpClient();
    try {
      cancellation?.throwIfCancelled();
      final index = await _fetchJsonObject(
        http,
        parsed,
        errorLabel: 'Pocket host config',
        progressStage: 'index',
        onProgress: onProgress,
        cancellation: cancellation,
      );
      cancellation?.throwIfCancelled();
      final resolved = await _resolveHostDocument(
        index,
        client: http,
        source: parsed,
        allowedHttpHosts: effectiveAllowedHosts,
        requiredRootPayloadSha256: requiredRootPayloadSha256,
        onProgress: onProgress,
        cancellation: cancellation,
      );
      cancellation?.throwIfCancelled();
      final document = resolved.document;
      await _hydrateBootstrapAssets(
        document,
        client: http,
        source: parsed,
        baseUri: resolved.baseUri,
        allowedHttpHosts: effectiveAllowedHosts,
        onProgress: onProgress,
        cancellation: cancellation,
      );
      cancellation?.throwIfCancelled();
      final loaded = PocketHostConfig.fromJson(
        document,
        source: parsed,
        allowInsecureHttpHosts: effectiveAllowedHosts,
        catalog: resolved.catalog,
        selectedCatalogEntry: resolved.selectedCatalogEntry,
        packageIndexSource: resolved.isIndex ? parsed : null,
      );
      cancellation?.throwIfCancelled();
      final trustDirectory = await getTrustDirectory();
      cancellation?.throwIfCancelled();
      await _checkTrustAnchor(
        loaded,
        directory: trustDirectory,
        cancellation: cancellation,
      );
      cancellation?.throwIfCancelled();
      await _persistCachedHostConfig(
        loaded,
        resolved: resolved,
        trustDirectory: trustDirectory,
        cancellation: cancellation,
      );
      cancellation?.throwIfCancelled();
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
    bool cacheFirst = false,
    PocketHostLoadProgressCallback? onProgress,
    PocketCancellationToken? cancellation,
  }) {
    const raw = String.fromEnvironment('POCKET_HOST_CONFIG_URL');
    if (raw.isEmpty) return Future<PocketHostConfig?>.value(null);
    final uri = Uri.tryParse(raw);
    if (uri == null) {
      return Future<PocketHostConfig?>.error(
        const FormatException('POCKET_HOST_CONFIG_URL is not a valid URL'),
      );
    }
    return load(
      uri,
      requiredRootPayloadSha256: requiredRootPayloadSha256,
      cacheFirst: cacheFirst,
      onProgress: onProgress,
      cancellation: cancellation,
    );
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

Set<String> _normalizeHosts(Iterable<String> hosts) => <String>{
  for (final host in hosts)
    if (host.isNotEmpty) host.toLowerCase(),
};

Set<String> _approvedDebugHosts(Set<String> declared, Set<String> allowed) =>
    _normalizeHosts(declared).intersection(allowed);

Future<void> _hydrateBootstrapAssets(
  Map<String, dynamic> document, {
  required HttpClient client,
  required Uri source,
  required Uri baseUri,
  required Set<String> allowedHttpHosts,
  PocketHostLoadProgressCallback? onProgress,
  PocketCancellationToken? cancellation,
}) => _processBootstrapAssets(
  document,
  source: source,
  baseUri: baseUri,
  allowedHttpHosts: allowedHttpHosts,
  cancellation: cancellation,
  loadAsset: (spec, {inlineMetadata, inlineManifest}) async {
    final bytes = await _fetchBytes(
      client,
      spec.uri,
      maxBytes: spec.expectedSize,
      progressStage: 'bootstrapAsset',
      progressTotalBytes: spec.expectedSize,
      onProgress: onProgress,
      cancellation: cancellation,
    );
    cancellation?.throwIfCancelled();
    final actualHash = await _awaitCancellable(
      _bootstrapBytesSha256InWorker(bytes),
      cancellation,
    );
    cancellation?.throwIfCancelled();
    if (bytes.length != spec.expectedSize ||
        actualHash.toLowerCase() != spec.expectedHash.toLowerCase()) {
      throw FormatException(
        'Bootstrap asset verification failed: ${spec.name}',
      );
    }
    return (utf8.decode(bytes), bytes.length);
  },
);

final class _BootstrapAssetSpec {
  const _BootstrapAssetSpec({
    required this.name,
    required this.uri,
    required this.expectedHash,
    required this.expectedSize,
  });

  final String name;
  final Uri uri;
  final String expectedHash;
  final int expectedSize;
}

Future<void> _processBootstrapAssets(
  Map<String, dynamic> document, {
  required Uri source,
  required Uri baseUri,
  required Set<String> allowedHttpHosts,
  required PocketCancellationToken? cancellation,
  required Future<(String, int)?> Function(
    _BootstrapAssetSpec spec, {
    required String? inlineMetadata,
    required String? inlineManifest,
  })
  loadAsset,
}) async {
  cancellation?.throwIfCancelled();
  final applications = _object(document['applications'], 'applications');
  var totalBytes = 0;
  for (final entry in applications.entries) {
    cancellation?.throwIfCancelled();
    final package = _packageMap(entry.value);
    if (package == null) {
      throw FormatException('Pocket host application ${entry.key} is invalid');
    }
    final inlineMetadata = _string(package, 'bootstrapMetadataJson');
    final inlineManifest = _string(package, 'bootstrapManifestJson');
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
      cancellation?.throwIfCancelled();
      final name = assetEntry.key.toString();
      final descriptor = _object(assetEntry.value, 'bootstrapAssets.$name');
      final urlValue = _string(descriptor, 'url');
      final expectedHash = _string(descriptor, 'sha256');
      final expectedSize = _integer(descriptor, 'size', required: true);
      if (urlValue == null || expectedHash == null || expectedSize == null) {
        throw FormatException('Invalid bootstrap asset $name');
      }
      if (!RegExp(r'^[0-9a-fA-F]{64}$').hasMatch(expectedHash)) {
        throw FormatException('Invalid bootstrap asset hash $name');
      }
      if (expectedSize <= 0 || expectedSize > _bootstrapAssetMaxBytes) {
        throw FormatException(
          'Invalid bootstrap asset size $name: $expectedSize',
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
      final verified = await loadAsset(
        _BootstrapAssetSpec(
          name: name,
          uri: uri,
          expectedHash: expectedHash,
          expectedSize: expectedSize,
        ),
        inlineMetadata: inlineMetadata,
        inlineManifest: inlineManifest,
      );
      cancellation?.throwIfCancelled();
      if (verified == null) continue;
      totalBytes += verified.$2;
      if (name.endsWith('app.bytecode.json')) {
        package['bootstrapMetadataJson'] = verified.$1;
        metadataVerified = true;
      } else if (name.endsWith('guest-manifest.json')) {
        package['bootstrapManifestJson'] = verified.$1;
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
  cancellation?.throwIfCancelled();
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
  PocketHostLoadProgressCallback? onProgress,
  PocketCancellationToken? cancellation,
}) async {
  cancellation?.throwIfCancelled();
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
  cancellation?.throwIfCancelled();
  final descriptorUri = selected.hostConfigUrl;
  final descriptor = await _fetchJsonObject(
    client,
    descriptorUri,
    errorLabel: 'Pocket host descriptor',
    progressStage: 'descriptor',
    onProgress: onProgress,
    cancellation: cancellation,
  );
  cancellation?.throwIfCancelled();
  _verifyHostDescriptorDocument(
    descriptor,
    expectedRoot: _string(index, 'systemUI') ?? _string(index, 'rootAppId'),
    expectedPayloadSha256: selected.rootPayloadSha256,
  );
  return _ResolvedHostDocument(
    document: descriptor,
    baseUri: descriptorUri,
    catalog: entries,
    selectedCatalogEntry: selected,
    isIndex: true,
  );
}

void _verifyHostDescriptorDocument(
  Map<String, dynamic> descriptor, {
  String? expectedRoot,
  String? expectedPayloadSha256,
}) {
  if (descriptor['kind'] != 'pocket-editor-app-host') {
    throw const FormatException(
      'Pocket package index descriptor is not a host config',
    );
  }
  if (expectedRoot != null && descriptor['systemUI'] != expectedRoot) {
    throw const FormatException(
      'Pocket package index and host descriptor select different SystemUI apps',
    );
  }
  if (expectedPayloadSha256 != null) {
    final applications = _object(descriptor['applications'], 'applications');
    final rootId = _string(descriptor, 'systemUI');
    final root = rootId == null ? null : _packageMap(applications[rootId]);
    final actualPayload =
        (root == null ? null : _string(root, 'payloadSha256')) ??
        _string(descriptor, 'rootPayloadSha256');
    if (actualPayload == null ||
        actualPayload.toLowerCase() != expectedPayloadSha256.toLowerCase()) {
      throw const FormatException(
        'Pocket package index does not match the immutable root descriptor',
      );
    }
  }
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
  required String progressStage,
  PocketHostLoadProgressCallback? onProgress,
  PocketCancellationToken? cancellation,
}) async {
  cancellation?.throwIfCancelled();
  final opened = await _openHttpResponse(
    client,
    uri,
    cancellation: cancellation,
  );
  final response = opened.response;
  _checkCancellation(cancellation, abortRequest: opened.abort);
  if (response.statusCode != HttpStatus.ok) {
    throw HttpException(
      '$errorLabel request failed: ${response.statusCode}',
      uri: uri,
    );
  }
  final body = utf8.decode(
    await _readHttpBytes(
      response,
      uri: uri,
      maxBytes: _hostConfigMaxBytes,
      progressStage: progressStage,
      onProgress: onProgress,
      cancellation: cancellation,
      abortRequest: opened.abort,
    ),
  );
  cancellation?.throwIfCancelled();
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
  required String progressStage,
  int? progressTotalBytes,
  PocketHostLoadProgressCallback? onProgress,
  PocketCancellationToken? cancellation,
}) async {
  cancellation?.throwIfCancelled();
  final opened = await _openHttpResponse(
    client,
    uri,
    cancellation: cancellation,
  );
  final response = opened.response;
  _checkCancellation(cancellation, abortRequest: opened.abort);
  if (response.statusCode != HttpStatus.ok) {
    throw HttpException(
      'Bootstrap asset request failed: ${response.statusCode}',
      uri: uri,
    );
  }
  return _readHttpBytes(
    response,
    uri: uri,
    maxBytes: maxBytes,
    progressStage: progressStage,
    progressTotalBytes: progressTotalBytes,
    onProgress: onProgress,
    cancellation: cancellation,
    abortRequest: opened.abort,
  );
}

final class _OpenedHttpResponse {
  const _OpenedHttpResponse(this.response, this.request);

  final HttpClientResponse response;
  final HttpClientRequest request;

  void abort() => request.abort();
}

Future<_OpenedHttpResponse> _openHttpResponse(
  HttpClient client,
  Uri uri, {
  PocketCancellationToken? cancellation,
}) async {
  cancellation?.throwIfCancelled();
  final requestFuture = client.getUrl(uri);
  HttpClientRequest? request;
  try {
    final openedRequest = await _awaitCancellable(
      requestFuture.timeout(_httpRequestTimeout),
      cancellation,
    );
    request = openedRequest;
    cancellation?.throwIfCancelled();
    openedRequest.followRedirects = false;
    final response = await _awaitCancellable(
      openedRequest.close().timeout(_httpRequestTimeout),
      cancellation,
    );
    cancellation?.throwIfCancelled();
    return _OpenedHttpResponse(response, openedRequest);
  } on PocketUpdateCancellation {
    request?.abort();
    if (request == null && cancellation?.isCancelled == true) {
      // `getUrl` may still be connecting when cancellation wins. Abort the
      // request as soon as HttpClient hands it back, without closing the
      // caller-owned client.
      requestFuture.then<void>(
        (lateRequest) => lateRequest.abort(),
        onError: (Object _, StackTrace __) {},
      );
    }
    rethrow;
  } on TimeoutException {
    request?.abort();
    if (cancellation?.isCancelled == true) {
      throw const PocketUpdateCancellation();
    }
    throw HttpException('HTTP request timed out', uri: uri);
  }
}

Future<List<int>> _readHttpBytes(
  HttpClientResponse response, {
  required Uri uri,
  required int maxBytes,
  required String progressStage,
  int? progressTotalBytes,
  PocketHostLoadProgressCallback? onProgress,
  PocketCancellationToken? cancellation,
  void Function()? abortRequest,
}) async {
  cancellation?.throwIfCancelled();
  if (maxBytes < 0) {
    throw const FormatException('HTTP body size limit must not be negative');
  }
  final contentLength = response.contentLength;
  final knownTotalBytes =
      progressTotalBytes ?? (contentLength >= 0 ? contentLength : null);
  if (contentLength > maxBytes) {
    throw FormatException(
      'HTTP body exceeds the size limit for $uri: $contentLength > $maxBytes',
    );
  }
  final iterator = StreamIterator<List<int>>(response);
  final bytes = BytesBuilder(copy: false);
  var length = 0;
  var cancellationWon = false;
  void reportProgress() {
    cancellation?.throwIfCancelled();
    onProgress?.call(
      PocketHostLoadProgress(
        stage: progressStage,
        downloadedBytes: length,
        totalBytes: knownTotalBytes,
      ),
    );
  }

  Future<List<int>> readBody() async {
    reportProgress();
    while (await iterator.moveNext().timeout(_httpBodyTimeout)) {
      cancellation?.throwIfCancelled();
      final chunk = iterator.current;
      if (chunk.length > maxBytes - length) {
        throw FormatException('HTTP body exceeds the size limit for $uri');
      }
      bytes.add(chunk);
      length += chunk.length;
      reportProgress();
    }
    cancellation?.throwIfCancelled();
    return bytes.takeBytes();
  }

  try {
    return await _awaitCancellable(readBody(), cancellation);
  } on PocketUpdateCancellation {
    cancellationWon = true;
    abortRequest?.call();
    rethrow;
  } on TimeoutException {
    if (cancellation?.isCancelled == true) {
      cancellationWon = true;
      abortRequest?.call();
      throw const PocketUpdateCancellation();
    }
    throw HttpException('HTTP body timed out', uri: uri);
  } finally {
    final cleanup = iterator.cancel();
    if (cancellationWon) {
      // A response stream's cancellation may wait for its source to finish.
      // The request has already been aborted, so let that cleanup settle
      // without delaying cancellation of the host load itself.
      unawaited(cleanup.catchError((Object _, StackTrace __) {}));
    } else {
      await cleanup.timeout(_httpRequestTimeout, onTimeout: () {});
    }
  }
}

Future<PocketHostConfig?> _tryLoadCachedHostConfig(
  Uri source, {
  required Set<String> allowedHttpHosts,
  required Directory trustDirectory,
  required String? requiredRootPayloadSha256,
  required PocketCancellationToken? cancellation,
}) async {
  cancellation?.throwIfCancelled();
  final cacheDir = _hostConfigCacheDirectory(trustDirectory);
  if (!await cacheDir.exists()) return null;
  final sourceKey = _hostConfigSourceKey(source);
  final expectedRootHash = requiredRootPayloadSha256?.toLowerCase();
  if (expectedRootHash != null &&
      !RegExp(r'^[0-9a-f]{64}$').hasMatch(expectedRootHash)) {
    return null;
  }
  final file = expectedRootHash != null
      ? _hostConfigRootCacheFile(cacheDir, sourceKey, expectedRootHash)
      : _hostConfigLatestCacheFile(cacheDir, sourceKey);
  return _readCachedHostConfigFile(
    file,
    source: source,
    allowedHttpHosts: allowedHttpHosts,
    trustDirectory: trustDirectory,
    expectedRootHash: expectedRootHash,
    cancellation: cancellation,
  );
}

Future<PocketHostConfig?> _readCachedHostConfigFile(
  File file, {
  required Uri source,
  required Set<String> allowedHttpHosts,
  required Directory trustDirectory,
  required String? expectedRootHash,
  required PocketCancellationToken? cancellation,
}) async {
  cancellation?.throwIfCancelled();
  if (!await file.exists()) return null;
  Map<String, dynamic> envelope;
  try {
    final stat = await file.stat();
    if (stat.size <= 0 || stat.size > _hostCacheMaxFileBytes) {
      await _deleteQuietly(file);
      return null;
    }
    final raw = await _awaitCancellable(file.readAsString(), cancellation);
    cancellation?.throwIfCancelled();
    final decoded = jsonDecode(raw);
    if (decoded is! Map) {
      await _deleteQuietly(file);
      return null;
    }
    envelope = Map<String, dynamic>.from(decoded);
  } on PocketUpdateCancellation {
    rethrow;
  } on Object {
    await _deleteQuietly(file);
    return null;
  }

  PocketHostConfig loaded;
  try {
    if (envelope['schemaVersion'] != 1 ||
        envelope['kind'] != 'pocket-host-bootstrap-cache') {
      throw const FormatException('Unsupported Pocket host bootstrap cache');
    }
    final cachedSource = _string(envelope, 'source');
    if (cachedSource != _hostConfigSourceKey(source)) {
      throw const FormatException(
        'Pocket host bootstrap cache source mismatch',
      );
    }
    final isIndex = _boolean(envelope, 'isIndex') ?? false;
    final baseUriString = _string(envelope, 'baseUri');
    if (baseUriString == null) {
      throw const FormatException(
        'Pocket host bootstrap cache missing baseUri',
      );
    }
    final baseUri = _resolveSameOriginUri(
      source,
      baseUriString,
      source: source,
      allowedHttpHosts: allowedHttpHosts,
      label: 'Cached Pocket host descriptor',
    );
    final document = _object(envelope['document'], 'document');
    final catalog = <PocketHostCatalogEntry>[];
    PocketHostCatalogEntry? selectedCatalogEntry;
    if (isIndex) {
      final rawCatalog = envelope['catalog'];
      if (rawCatalog is! List || rawCatalog.isEmpty) {
        throw const FormatException(
          'Cached Pocket package index catalog must be a non-empty array',
        );
      }
      for (final raw in rawCatalog) {
        if (raw is! Map) {
          throw const FormatException(
            'Cached Pocket package index entry is invalid',
          );
        }
        final entry = _catalogEntry(
          const <String, dynamic>{},
          Map<String, dynamic>.from(raw),
          source,
          allowedHttpHosts,
        );
        if (!catalog.any(
          (candidate) =>
              candidate.hostConfigUrl == entry.hostConfigUrl &&
              candidate.rootPayloadSha256 == entry.rootPayloadSha256,
        )) {
          catalog.add(entry);
        }
      }
      final rawSelected = _object(
        envelope['selectedCatalogEntry'],
        'selectedCatalogEntry',
      );
      final parsedSelected = _catalogEntry(
        const <String, dynamic>{},
        rawSelected,
        source,
        allowedHttpHosts,
      );
      for (final entry in catalog) {
        if (entry.hostConfigUrl == parsedSelected.hostConfigUrl &&
            entry.rootPayloadSha256?.toLowerCase() ==
                parsedSelected.rootPayloadSha256?.toLowerCase()) {
          selectedCatalogEntry = entry;
          break;
        }
      }
      selectedCatalogEntry ??= parsedSelected;
      if (!catalog.contains(selectedCatalogEntry)) {
        catalog.insert(0, selectedCatalogEntry);
      }
    }
    _verifyHostDescriptorDocument(
      document,
      expectedPayloadSha256:
          expectedRootHash ?? selectedCatalogEntry?.rootPayloadSha256,
    );
    if (expectedRootHash != null &&
        selectedCatalogEntry?.rootPayloadSha256?.toLowerCase() !=
            expectedRootHash) {
      throw const FormatException(
        'Cached Pocket host descriptor root payload hash mismatch',
      );
    }
    await _verifyCachedBootstrapAssets(
      document,
      source: source,
      baseUri: baseUri,
      allowedHttpHosts: allowedHttpHosts,
      cancellation: cancellation,
    );
    cancellation?.throwIfCancelled();
    loaded = PocketHostConfig.fromJson(
      document,
      source: source,
      allowInsecureHttpHosts: allowedHttpHosts,
      catalog: catalog,
      selectedCatalogEntry: selectedCatalogEntry,
      packageIndexSource: isIndex ? source : null,
    );
  } on PocketUpdateCancellation {
    rethrow;
  } on Object {
    await _deleteQuietly(file);
    return null;
  }

  cancellation?.throwIfCancelled();
  await _checkTrustAnchor(
    loaded,
    directory: trustDirectory,
    cancellation: cancellation,
  );
  cancellation?.throwIfCancelled();
  return loaded;
}

Future<void> _verifyCachedBootstrapAssets(
  Map<String, dynamic> document, {
  required Uri source,
  required Uri baseUri,
  required Set<String> allowedHttpHosts,
  required PocketCancellationToken? cancellation,
}) => _processBootstrapAssets(
  document,
  source: source,
  baseUri: baseUri,
  allowedHttpHosts: allowedHttpHosts,
  cancellation: cancellation,
  loadAsset: (spec, {inlineMetadata, inlineManifest}) async {
    String? inlineContent;
    if (spec.name.endsWith('app.bytecode.json')) {
      inlineContent = inlineMetadata;
    } else if (spec.name.endsWith('guest-manifest.json')) {
      inlineContent = inlineManifest;
    } else {
      return null;
    }
    if (inlineContent == null) {
      throw FormatException(
        'Cached bootstrap asset missing content: ${spec.name}',
      );
    }
    final bytes = utf8.encode(inlineContent);
    final actualHash = _bootstrapBytesSha256(bytes);
    if (bytes.length != spec.expectedSize ||
        actualHash.toLowerCase() != spec.expectedHash.toLowerCase()) {
      throw FormatException(
        'Cached bootstrap asset verification failed: ${spec.name}',
      );
    }
    return (inlineContent, bytes.length);
  },
);

Future<void> _persistCachedHostConfig(
  PocketHostConfig config, {
  required _ResolvedHostDocument resolved,
  required Directory trustDirectory,
  required PocketCancellationToken? cancellation,
}) async {
  cancellation?.throwIfCancelled();
  final cacheDir = _hostConfigCacheDirectory(trustDirectory);
  final sourceKey = _hostConfigSourceKey(config.source);
  final envelope = <String, dynamic>{
    'schemaVersion': 1,
    'kind': 'pocket-host-bootstrap-cache',
    'source': sourceKey,
    'baseUri': resolved.baseUri.toString(),
    'isIndex': resolved.isIndex,
    'catalog': <Map<String, dynamic>>[
      for (final entry in config.catalog) _catalogEntryToJson(entry),
    ],
    if (config.selectedCatalogEntry != null)
      'selectedCatalogEntry': _catalogEntryToJson(config.selectedCatalogEntry!),
    'document': resolved.document,
  };
  final encoded = jsonEncode(envelope);
  if (utf8.encode(encoded).length > _hostCacheMaxFileBytes) {
    return;
  }
  cancellation?.throwIfCancelled();
  await cacheDir.create(recursive: true);
  cancellation?.throwIfCancelled();
  final rootHash = config.rootPayloadSha256?.toLowerCase();
  if (rootHash != null && RegExp(r'^[0-9a-f]{64}$').hasMatch(rootHash)) {
    final rootFile = _hostConfigRootCacheFile(cacheDir, sourceKey, rootHash);
    await _writeFileAtomically(rootFile, encoded, cancellation: cancellation);
  }
  final isLatestSelection =
      !resolved.isIndex ||
      (config.catalog.isNotEmpty &&
          config.selectedCatalogEntry != null &&
          config.selectedCatalogEntry!.hostConfigUrl ==
              config.catalog.first.hostConfigUrl &&
          config.selectedCatalogEntry!.rootPayloadSha256?.toLowerCase() ==
              config.catalog.first.rootPayloadSha256?.toLowerCase());
  if (isLatestSelection) {
    final latestFile = _hostConfigLatestCacheFile(cacheDir, sourceKey);
    await _writeFileAtomically(latestFile, encoded, cancellation: cancellation);
  }
  await _pruneHostConfigCache(cacheDir, cancellation: cancellation);
}

Map<String, dynamic> _catalogEntryToJson(PocketHostCatalogEntry entry) =>
    <String, dynamic>{
      if (entry.releaseId != null) 'releaseId': entry.releaseId,
      if (entry.packageId != null) 'packageId': entry.packageId,
      if (entry.version != null) 'version': entry.version,
      if (entry.build != null) 'build': entry.build,
      'hostConfigUrl': entry.hostConfigUrl.toString(),
      if (entry.rootPayloadSha256 != null)
        'rootPayloadSha256': entry.rootPayloadSha256,
    };

Directory _hostConfigCacheDirectory(Directory trustDirectory) =>
    Directory('${trustDirectory.path}/pocket-host-cache');

String _hostConfigSourceKey(Uri source) =>
    source.replace(fragment: null).toString();

File _hostConfigLatestCacheFile(Directory cacheDir, String sourceKey) {
  final digest = sha256.convert(utf8.encode('latest\n$sourceKey')).toString();
  return File('${cacheDir.path}/entry_${digest.substring(0, 32)}.json');
}

File _hostConfigRootCacheFile(
  Directory cacheDir,
  String sourceKey,
  String lowercaseRootPayloadSha256,
) {
  final digest = sha256
      .convert(utf8.encode('root\n$sourceKey\n$lowercaseRootPayloadSha256'))
      .toString();
  return File('${cacheDir.path}/entry_${digest.substring(0, 32)}.json');
}

Future<void> _writeFileAtomically(
  File file,
  String contents, {
  required PocketCancellationToken? cancellation,
}) async {
  cancellation?.throwIfCancelled();
  final sequence = ++_atomicWriteSequence;
  final temporary = File(
    '${file.path}.tmp-${DateTime.now().microsecondsSinceEpoch}-$sequence',
  );
  try {
    cancellation?.throwIfCancelled();
    await temporary.writeAsString(contents, flush: true);
    cancellation?.throwIfCancelled();
    await temporary.rename(file.path);
  } catch (_) {
    await _deleteQuietly(temporary);
    rethrow;
  }
}

Future<void> _pruneHostConfigCache(
  Directory cacheDir, {
  required PocketCancellationToken? cancellation,
}) async {
  cancellation?.throwIfCancelled();
  try {
    if (!await cacheDir.exists()) return;
    final entries = <(File, DateTime)>[];
    await for (final entity in cacheDir.list(followLinks: false)) {
      cancellation?.throwIfCancelled();
      if (entity is! File) continue;
      final name = entity.uri.pathSegments.isEmpty
          ? ''
          : entity.uri.pathSegments.last;
      if (name.contains('.tmp-')) {
        await _deleteQuietly(entity);
        continue;
      }
      if (!name.startsWith('entry_') || !name.endsWith('.json')) continue;
      final stat = await entity.stat();
      entries.add((entity, stat.modified));
    }
    if (entries.length <= _hostCacheMaxEntries) return;
    entries.sort((a, b) => b.$2.compareTo(a.$2));
    for (final stale in entries.skip(_hostCacheMaxEntries)) {
      cancellation?.throwIfCancelled();
      await _deleteQuietly(stale.$1);
    }
  } on PocketUpdateCancellation {
    rethrow;
  } on Object {
    // Pruning is best-effort maintenance and must not fail a verified load.
  }
}

Future<void> _deleteQuietly(File file) async {
  try {
    if (await file.exists()) await file.delete();
  } on Object {
    // Ignore best-effort cleanup errors.
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
  PocketCancellationToken? cancellation,
}) async {
  cancellation?.throwIfCancelled();
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
  cancellation?.throwIfCancelled();
  if (await file.exists()) {
    cancellation?.throwIfCancelled();
    final decoded = jsonDecode(await file.readAsString());
    cancellation?.throwIfCancelled();
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
  cancellation?.throwIfCancelled();
  anchors[scope] = key;
  document['anchors'] = anchors;
  await directory.create(recursive: true);
  cancellation?.throwIfCancelled();
  final temporary = File(
    '${file.path}.tmp-${DateTime.now().microsecondsSinceEpoch}',
  );
  try {
    cancellation?.throwIfCancelled();
    await temporary.writeAsString(jsonEncode(document), flush: true);
    cancellation?.throwIfCancelled();
    await temporary.rename(file.path);
  } catch (_) {
    if (await temporary.exists()) await temporary.delete();
    rethrow;
  }
}

Future<T> _awaitCancellable<T>(
  Future<T> future,
  PocketCancellationToken? cancellation,
) {
  if (cancellation == null) return future;
  cancellation.throwIfCancelled();
  return Future.any<T>(<Future<T>>[
    future,
    cancellation.whenCancelled.then<T>(
      (_) => throw const PocketUpdateCancellation(),
    ),
  ]);
}

void _checkCancellation(
  PocketCancellationToken? cancellation, {
  void Function()? abortRequest,
}) {
  try {
    cancellation?.throwIfCancelled();
  } on PocketUpdateCancellation {
    abortRequest?.call();
    rethrow;
  }
}

// Keep the worker closure outside HTTP loader contexts: those capture an
// HttpClient, which cannot cross an isolate boundary.
Future<String> _bootstrapBytesSha256InWorker(List<int> bytes) =>
    Isolate.run<String>(() => _bootstrapBytesSha256(bytes));

String _bootstrapBytesSha256(List<int> bytes) =>
    sha256.convert(bytes).toString();

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
    return kDebugMode || allowed.contains(uri.host);
  }
  return allowed.contains(uri.host);
}
