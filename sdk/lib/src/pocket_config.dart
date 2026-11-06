import 'package:flutter/foundation.dart';
import 'package:pocket_flutter/pocket_flutter.dart';
import 'package:pocket_services/pocket_services.dart';

/// A new provider instance is created for each verified guest generation.
typedef PocketPluginFactory =
    PocketPlugin Function(PocketViewController controller);

/// A fresh provider is owned and closed by each native guest generation.
typedef PocketOffloadProviderFactory = PocketOffloadProvider Function();

/// Public-key-only signed update configuration. No signing key enters an app.
final class PocketUpdateConfig {
  const PocketUpdateConfig({
    this.url = '',
    this.baseUrl = '',
    this.hostVersion = '',
    this.packageVersion = '',
    this.keyId = '',
    this.publicKey = '',
    this.namespace = 'default',
    this.trustRootKeyId,
    this.trustRootPublicKey,
    this.trustPolicyUrl,
    List<String> debugHttpHosts = const <String>[],
  }) : _debugHttpHosts = debugHttpHosts;
  const PocketUpdateConfig.fromEnvironment()
    : url = const String.fromEnvironment('POCKET_UPDATE_URL'),
      baseUrl = const String.fromEnvironment('POCKET_UPDATE_BASE_URL'),
      hostVersion = const String.fromEnvironment('POCKET_HOST_VERSION'),
      packageVersion = const String.fromEnvironment('POCKET_PACKAGE_VERSION'),
      keyId = const String.fromEnvironment('POCKET_UPDATE_KEY_ID'),
      publicKey = const String.fromEnvironment('POCKET_UPDATE_PUBLIC_KEY'),
      namespace = const String.fromEnvironment(
        'POCKET_STORE_NAMESPACE',
        defaultValue: 'default',
      ),
      trustRootKeyId = const String.fromEnvironment('POCKET_TRUST_ROOT_KEY_ID'),
      trustRootPublicKey = const String.fromEnvironment(
        'POCKET_TRUST_ROOT_PUBLIC_KEY',
      ),
      trustPolicyUrl = const String.fromEnvironment('POCKET_TRUST_POLICY_URL'),
      _debugHttpHosts = const <String>[
        String.fromEnvironment('POCKET_UPDATE_DEBUG_HTTP_HOST'),
      ];
  final String url;

  /// Deployment origin (or origin plus a fixed prefix) for the canonical
  /// `<base>/pocket/<hostVersion>/<packageId>/<packageVersion>/latest.json`
  /// update layout. Use this with [hostVersion] and [packageVersion] instead
  /// of supplying a raw [url].
  final String baseUrl;
  final String hostVersion;

  /// Release slot in the URL. Use an immutable version for pinned delivery or
  /// a stable slot such as `stable` when the server will replace only the
  /// signed `latest.json` pointer while retaining immutable hashed artifacts.
  final String packageVersion;
  final String keyId;

  /// Base64-encoded Ed25519 public key.
  final String publicKey;
  final String namespace;

  /// Optional host-owned root policy configuration. When all three fields are
  /// present, the update coordinator ignores the legacy release key above and
  /// admits only keys certified by the signed policy.
  final String? trustRootKeyId;
  final String? trustRootPublicKey;
  final String? trustPolicyUrl;

  bool get trustPolicyConfigured =>
      _sourceConfigured &&
      trustRootKeyId?.isNotEmpty == true &&
      trustRootPublicKey?.isNotEmpty == true &&
      trustPolicyUrl?.isNotEmpty == true;

  /// Additional HTTP hosts allowed for signed updates in debug builds only.
  /// Loopback and Android's emulator host remain built-in debug hosts.
  final List<String> _debugHttpHosts;
  List<String> get debugHttpHosts =>
      _debugHttpHosts.length == 1 && _debugHttpHosts.first.isEmpty
      ? const <String>[]
      : _debugHttpHosts;
  bool get _structuredEndpointConfigured =>
      baseUrl.isNotEmpty && hostVersion.isNotEmpty && packageVersion.isNotEmpty;
  bool get _sourceConfigured => url.isNotEmpty || _structuredEndpointConfigured;
  bool get configured =>
      (_sourceConfigured && keyId.isNotEmpty && publicKey.isNotEmpty) ||
      trustPolicyConfigured;

  /// Resolves the signed manifest endpoint for [packageId].
  ///
  /// [url] remains available for local Editor endpoints and existing hosts.
  /// Production deployments should use the structured fields so every app
  /// shares the same deterministic CDN layout.
  Uri manifestUri(String packageId) {
    validate();
    if (url.isNotEmpty) return Uri.parse(url);
    final base = Uri.parse(baseUrl);
    return base.replace(
      pathSegments: <String>[
        ...base.pathSegments.where((segment) => segment.isNotEmpty),
        'pocket',
        hostVersion,
        packageId,
        packageVersion,
        'latest.json',
      ],
      query: null,
      fragment: null,
    );
  }

  void validate() {
    final endpointFields = <String>[baseUrl, hostVersion, packageVersion];
    final hasEndpoint = endpointFields.any((value) => value.isNotEmpty);
    if (url.isNotEmpty && hasEndpoint) {
      throw const FormatException(
        'Use either a direct update URL or the structured update endpoint',
      );
    }
    if (hasEndpoint && !_structuredEndpointConfigured) {
      throw const FormatException(
        'Update base URL, host version, and package version must be configured together',
      );
    }
    if (_structuredEndpointConfigured) {
      final base = Uri.tryParse(baseUrl);
      if (base == null ||
          !base.hasScheme ||
          base.host.isEmpty ||
          (base.scheme != 'https' && base.scheme != 'http') ||
          base.userInfo.isNotEmpty ||
          base.hasQuery ||
          base.hasFragment) {
        throw const FormatException('Invalid update base URL');
      }
      final segment = RegExp(r'^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$');
      if (!segment.hasMatch(hostVersion) || !segment.hasMatch(packageVersion)) {
        throw const FormatException('Invalid update host/package version');
      }
    }
    final hasLegacy = keyId.isNotEmpty || publicKey.isNotEmpty;
    final hasTrust =
        trustRootKeyId?.isNotEmpty == true ||
        trustRootPublicKey?.isNotEmpty == true ||
        trustPolicyUrl?.isNotEmpty == true;
    final legacyComplete =
        _sourceConfigured && keyId.isNotEmpty && publicKey.isNotEmpty;
    if ((hasLegacy && !legacyComplete) ||
        (hasTrust && !trustPolicyConfigured) ||
        (_sourceConfigured && !legacyComplete && !trustPolicyConfigured)) {
      throw const FormatException(
        'Update URL/key ID/public key or trust root/policy must be configured together',
      );
    }
    if (!RegExp(r'^[a-zA-Z0-9_-]+$').hasMatch(namespace)) {
      throw const FormatException('Invalid package store namespace');
    }
  }

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is PocketUpdateConfig &&
          runtimeType == other.runtimeType &&
          url == other.url &&
          baseUrl == other.baseUrl &&
          hostVersion == other.hostVersion &&
          packageVersion == other.packageVersion &&
          keyId == other.keyId &&
          publicKey == other.publicKey &&
          namespace == other.namespace &&
          trustRootKeyId == other.trustRootKeyId &&
          trustRootPublicKey == other.trustRootPublicKey &&
          trustPolicyUrl == other.trustPolicyUrl &&
          listEquals(debugHttpHosts, other.debugHttpHosts);

  @override
  int get hashCode => Object.hash(
    url,
    baseUrl,
    hostVersion,
    packageVersion,
    keyId,
    publicKey,
    namespace,
    trustRootKeyId,
    trustRootPublicKey,
    trustPolicyUrl,
    Object.hashAll(debugHttpHosts),
  );
}

/// App-specific identity and admission policy, separate from the reusable host.
final class PocketAppConfig {
  const PocketAppConfig({
    required this.appId,
    this.bytecodeAsset = 'assets/app.qjbc',
    this.pakAsset = 'assets/app.pak',
    this.metadataAsset = 'assets/app.bytecode.json',
    this.manifestAsset = 'assets/guest-manifest.json',
    this.updates,
    this.downloadOnOpen = false,
    this.showFps = false,
    this.allowedPermissions = const {},
    this.pluginFactories = const [],
    this.additionalCapabilities = const {},
    this.recordingFactory,
    this.compositorSurfaces = const {},
    this.workerHttpOrigins = const {},
    this.offloadProviderFactory,
    this.memoryLimits = const PocketMemoryLimits(),
  });
  final String appId;
  final String bytecodeAsset;
  final String pakAsset;
  final String metadataAsset;
  final String manifestAsset;
  final PocketMemoryLimits memoryLimits;

  /// Signed package source used by the native System runtime's optional
  /// before-open gate, including resident/prewarmed mini-apps. When omitted,
  /// the runtime keeps the local embedded/cache path and performs no remote
  /// check.
  final PocketUpdateConfig? updates;

  /// Downloads the signed mini-app package when the runtime is opened.
  ///
  /// The local metadata and guest manifest remain the small ABI/bootstrap
  /// assets, but the executable entry and PAK must come from a verified
  /// update package. This mode therefore requires a complete [updates]
  /// configuration and has no embedded bytecode fallback.
  final bool downloadOnOpen;

  final bool showFps;
  final Set<String> allowedPermissions;
  final List<PocketPluginFactory> pluginFactories;
  final Set<String> additionalCapabilities;

  /// Trusted application handles (2..63) available to SystemUI CompositorSurface.
  final Map<String, int> compositorSurfaces;

  /// Exact trusted HTTP(S) origins granted to worker HTTP nodes.
  final Set<String> workerHttpOrigins;

  /// Trusted async methods exposed through the official io.offload protocol.
  /// No provider or network permission is enabled by default.
  final PocketOffloadProviderFactory? offloadProviderFactory;

  /// Creates a bounded debug recorder before each new native guest loads.
  /// Keep the callback stable across parent rebuilds, as with plugin factories.
  final PocketRecordingController Function()? recordingFactory;

  /// Copy this config while replacing extensions or the memory allowance.
  ///
  /// The constructor below is the single field-preserving copy boundary used
  /// by host composition and plugin attachment. Omitted lists retain their
  /// existing instances; supplied iterables are snapshotted.
  PocketAppConfig copyWith({
    Iterable<PocketPluginFactory>? pluginFactories,
    Iterable<String>? additionalCapabilities,
    PocketMemoryLimits? memoryLimits,
    PocketRecordingController Function()? recordingFactory,
    bool? downloadOnOpen,
  }) => PocketAppConfig(
    appId: appId,
    bytecodeAsset: bytecodeAsset,
    pakAsset: pakAsset,
    metadataAsset: metadataAsset,
    manifestAsset: manifestAsset,
    updates: updates,
    downloadOnOpen: downloadOnOpen ?? this.downloadOnOpen,
    showFps: showFps,
    allowedPermissions: allowedPermissions,
    pluginFactories: pluginFactories == null
        ? this.pluginFactories
        : List<PocketPluginFactory>.unmodifiable(pluginFactories),
    additionalCapabilities: additionalCapabilities == null
        ? this.additionalCapabilities
        : Set<String>.unmodifiable(additionalCapabilities),
    recordingFactory: recordingFactory ?? this.recordingFactory,
    compositorSurfaces: compositorSurfaces,
    workerHttpOrigins: workerHttpOrigins,
    offloadProviderFactory: offloadProviderFactory,
    memoryLimits: memoryLimits ?? this.memoryLimits,
  );

  /// Attach compiled providers without changing the app's assets or policy.
  PocketAppConfig withPlugins(Iterable<PocketPluginFactory> factories) =>
      copyWith(pluginFactories: factories);

  void validate() {
    if (!RegExp(r'^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$').hasMatch(appId)) {
      throw const FormatException('Invalid Pocket application ID');
    }
    final handles = <int>{};
    for (final entry in compositorSurfaces.entries) {
      if (!RegExp(r'^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$').hasMatch(entry.key) ||
          entry.value < 2 ||
          entry.value > 63 ||
          !handles.add(entry.value)) {
        throw const FormatException('Invalid compositor application registry');
      }
    }
    updates?.validate();
    if (downloadOnOpen && !(updates?.configured ?? false)) {
      throw const FormatException(
        'downloadOnOpen requires a complete signed update configuration',
      );
    }
    memoryLimits.validate();
  }

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is PocketAppConfig &&
          runtimeType == other.runtimeType &&
          appId == other.appId &&
          bytecodeAsset == other.bytecodeAsset &&
          pakAsset == other.pakAsset &&
          metadataAsset == other.metadataAsset &&
          manifestAsset == other.manifestAsset &&
          updates == other.updates &&
          downloadOnOpen == other.downloadOnOpen &&
          memoryLimits == other.memoryLimits &&
          showFps == other.showFps &&
          recordingFactory == other.recordingFactory &&
          offloadProviderFactory == other.offloadProviderFactory &&
          mapEquals(compositorSurfaces, other.compositorSurfaces) &&
          setEquals(workerHttpOrigins, other.workerHttpOrigins) &&
          setEquals(allowedPermissions, other.allowedPermissions) &&
          listEquals(pluginFactories, other.pluginFactories) &&
          setEquals(additionalCapabilities, other.additionalCapabilities);

  @override
  int get hashCode => Object.hash(
    appId,
    bytecodeAsset,
    pakAsset,
    metadataAsset,
    manifestAsset,
    updates,
    downloadOnOpen,
    memoryLimits,
    showFps,
    recordingFactory,
    offloadProviderFactory,
    Object.hashAllUnordered(workerHttpOrigins),
    Object.hashAllUnordered(
      compositorSurfaces.entries.map((e) => Object.hash(e.key, e.value)),
    ),
    Object.hashAllUnordered(allowedPermissions),
    Object.hashAll(pluginFactories),
    Object.hashAllUnordered(additionalCapabilities),
  );
}
