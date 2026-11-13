import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';
import 'package:pocket_flutter/pocket_flutter.dart';
import 'package:pocket_services/pocket_services.dart';

import 'pocket_diagnostics.dart';

/// A new provider instance is created for each verified guest generation.
typedef PocketPluginFactory =
    PocketPlugin Function(PocketViewController controller);

/// A fresh provider is owned and closed by each native guest generation.
typedef PocketOffloadProviderFactory = PocketOffloadProvider Function();

/// Public-key-only signed update configuration. No signing key enters an app.
final class PocketUpdateConfig {
  const PocketUpdateConfig({
    this.url = '',
    this.indexUrl = '',
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
      indexUrl = const String.fromEnvironment('POCKET_UPDATE_INDEX_URL'),
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

  /// Fixed package-index URL selected by the user-provided host entrypoint.
  /// Aggregate host configs use this instead of deriving a route from a
  /// remote release id or namespace.
  final String indexUrl;

  /// Deployment origin (or origin plus a fixed channel prefix) for the
  /// canonical `<base>/pocket/<hostVersion>/<packageId>/latest.json` update
  /// directory. The `latest.json` entry is the mutable version index; the
  /// selected immutable descriptor carries the package version and signed
  /// artifact URLs. [packageVersion] remains the compatibility/admission
  /// branch, but is deliberately not part of the public entry URL.
  final String baseUrl;
  final String hostVersion;

  /// Signed compatibility/admission branch for this package. It is carried in
  /// the signed descriptor and is intentionally not a URL segment: the fixed
  /// `latest.json` index is resolved on every coordinator check.
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

  /// HTTP hosts explicitly permitted by the host for signed updates.
  /// This allowlist applies in all build modes. The session adds its default
  /// development hosts only in debug builds.
  final List<String> _debugHttpHosts;
  List<String> get debugHttpHosts =>
      _debugHttpHosts.length == 1 && _debugHttpHosts.first.isEmpty
      ? const <String>[]
      : _debugHttpHosts;
  bool get _structuredEndpointConfigured =>
      baseUrl.isNotEmpty && hostVersion.isNotEmpty && packageVersion.isNotEmpty;
  bool get _sourceConfigured =>
      url.isNotEmpty || indexUrl.isNotEmpty || _structuredEndpointConfigured;
  bool get configured =>
      (_sourceConfigured && keyId.isNotEmpty && publicKey.isNotEmpty) ||
      trustPolicyConfigured;

  /// Resolves the mutable version-index endpoint for [packageId].
  ///
  /// [url] remains available for local Editor endpoints and existing hosts.
  /// Production deployments should use the structured fields so every app
  /// shares the same deterministic CDN layout.
  Uri manifestUri(String packageId) {
    validate();
    if (indexUrl.isNotEmpty) return Uri.parse(indexUrl);
    if (url.isNotEmpty) return Uri.parse(url);
    final base = Uri.parse(baseUrl);
    return base.replace(
      pathSegments: <String>[
        ...base.pathSegments.where((segment) => segment.isNotEmpty),
        'pocket',
        hostVersion,
        packageId,
        'latest.json',
      ],
      query: null,
      fragment: null,
    );
  }

  void validate() {
    final endpointFields = <String>[baseUrl, hostVersion, packageVersion];
    final hasEndpoint = endpointFields.any((value) => value.isNotEmpty);
    if (url.isNotEmpty && (indexUrl.isNotEmpty || hasEndpoint)) {
      throw const FormatException(
        'Use either a direct update URL or a package index/structured endpoint',
      );
    }
    if (indexUrl.isNotEmpty) {
      final index = Uri.tryParse(indexUrl);
      if (index == null ||
          !index.hasScheme ||
          index.host.isEmpty ||
          (index.scheme != 'https' && index.scheme != 'http') ||
          index.userInfo.isNotEmpty ||
          index.hasQuery ||
          index.hasFragment ||
          !index.path.endsWith('/latest.json')) {
        throw const FormatException('Invalid package index URL');
      }
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
          indexUrl == other.indexUrl &&
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
    indexUrl,
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
    this.fontFamilyFallback = const <String>[],
    this.keyboardInputEnabled = false,
    this.keyboardAutofocus = false,
    this.rawTextInputEnabled = false,
    this.textLayoutCacheCapacity = 256,
    this.keyboardButtonMap = const <LogicalKeyboardKey, int>{},
    this.allowedPermissions = const {},
    this.pluginFactories = const [],
    this.additionalCapabilities = const {},
    this.recordingFactory,
    this.diagnostics,
    this.compositorSurfaces = const {},
    this.workerHttpOrigins = const {},
    this.offloadProviderFactory,
    this.memoryLimits = const PocketMemoryLimits(),
    this.bootstrapMetadataJson,
    this.bootstrapManifestJson,
  });
  final String appId;
  final String bytecodeAsset;
  final String pakAsset;
  final String metadataAsset;
  final String manifestAsset;
  final PocketMemoryLimits memoryLimits;

  /// Verified bootstrap metadata fetched from a single host config document.
  /// When present, [PocketSession] uses these bytes instead of pretending that
  /// a remote file exists in `rootBundle`.
  final String? bootstrapMetadataJson;

  /// Verified guest manifest fetched from the same host config document.
  final String? bootstrapManifestJson;

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

  /// Additional Flutter font families tried after the fixed PocketJS slot
  /// family. This only affects glyph painting; baked PAK metrics continue to
  /// define JS line layout.
  final List<String> fontFamilyFallback;

  /// Registers the real Flutter keyboard as an official button input source.
  /// Explicit host policy; does not grant analog/gamepad hardware capabilities.
  final bool keyboardInputEnabled;
  final bool keyboardAutofocus;

  /// Host opt-in for guest-requested raw key/IME sessions (`textInput.rawOpen`).
  /// See docs/STUDIO_TEXT_INPUT.md. Policy stays in the guest; this only allows it.
  final bool rawTextInputEnabled;

  /// Capacity of the native text-layout cache of this app's [PocketView]
  /// (see `PocketView.textLayoutCacheCapacity`). Raise it for text-heavy apps
  /// such as code editors; the default keeps the standard behaviour.
  final int textLayoutCacheCapacity;

  /// Per-app overrides for Flutter logical keys. Values are PocketJS `BTN`
  /// bits; omitted keys keep PocketView's standard mapping.
  final Map<LogicalKeyboardKey, int> keyboardButtonMap;
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

  /// Optional host-owned diagnostics collector for durable crash and session
  /// boundary log persistence.
  final PocketHostDiagnostics? diagnostics;

  /// Copy this config while replacing extensions or the memory allowance.
  ///
  /// The constructor below is the single field-preserving copy boundary used
  /// by host composition and plugin attachment. Omitted lists retain their
  /// existing instances; supplied iterables are snapshotted.
  PocketAppConfig copyWith({
    Iterable<PocketPluginFactory>? pluginFactories,
    Iterable<String>? additionalCapabilities,
    PocketMemoryLimits? memoryLimits,
    PocketUpdateConfig? updates,
    PocketRecordingController Function()? recordingFactory,
    PocketHostDiagnostics? diagnostics,
    bool? downloadOnOpen,
    Iterable<String>? fontFamilyFallback,
    bool? keyboardInputEnabled,
    bool? keyboardAutofocus,
    bool? rawTextInputEnabled,
    int? textLayoutCacheCapacity,
    Map<LogicalKeyboardKey, int>? keyboardButtonMap,
    String? bootstrapMetadataJson,
    String? bootstrapManifestJson,
    Map<String, int>? compositorSurfaces,
  }) => PocketAppConfig(
    appId: appId,
    bytecodeAsset: bytecodeAsset,
    pakAsset: pakAsset,
    metadataAsset: metadataAsset,
    manifestAsset: manifestAsset,
    updates: updates ?? this.updates,
    downloadOnOpen: downloadOnOpen ?? this.downloadOnOpen,
    showFps: showFps,
    fontFamilyFallback: fontFamilyFallback == null
        ? this.fontFamilyFallback
        : List<String>.unmodifiable(fontFamilyFallback),
    keyboardInputEnabled: keyboardInputEnabled ?? this.keyboardInputEnabled,
    keyboardAutofocus: keyboardAutofocus ?? this.keyboardAutofocus,
    rawTextInputEnabled: rawTextInputEnabled ?? this.rawTextInputEnabled,
    textLayoutCacheCapacity:
        textLayoutCacheCapacity ?? this.textLayoutCacheCapacity,
    keyboardButtonMap: keyboardButtonMap ?? this.keyboardButtonMap,
    allowedPermissions: allowedPermissions,
    pluginFactories: pluginFactories == null
        ? this.pluginFactories
        : List<PocketPluginFactory>.unmodifiable(pluginFactories),
    additionalCapabilities: additionalCapabilities == null
        ? this.additionalCapabilities
        : Set<String>.unmodifiable(additionalCapabilities),
    recordingFactory: recordingFactory ?? this.recordingFactory,
    diagnostics: diagnostics ?? this.diagnostics,
    compositorSurfaces: compositorSurfaces ?? this.compositorSurfaces,
    workerHttpOrigins: workerHttpOrigins,
    offloadProviderFactory: offloadProviderFactory,
    memoryLimits: memoryLimits ?? this.memoryLimits,
    bootstrapMetadataJson: bootstrapMetadataJson ?? this.bootstrapMetadataJson,
    bootstrapManifestJson: bootstrapManifestJson ?? this.bootstrapManifestJson,
  );

  /// Attach compiled providers without changing the app's assets or policy.
  PocketAppConfig withPlugins(Iterable<PocketPluginFactory> factories) =>
      copyWith(pluginFactories: factories);

  /// Keep this remotely selected package while applying host-approved native
  /// policy. Remote data owns identity, artifacts, updates and bootstrap
  /// metadata; [policy] owns permissions, plugins, native providers and
  /// resource limits. This is the single boundary used by aggregate host
  /// configuration so consumers do not duplicate a field-by-field merge.
  PocketAppConfig withNativePolicy(PocketAppConfig policy) => PocketAppConfig(
    appId: appId,
    bytecodeAsset: bytecodeAsset,
    pakAsset: pakAsset,
    metadataAsset: metadataAsset,
    manifestAsset: manifestAsset,
    updates: updates,
    downloadOnOpen: downloadOnOpen,
    showFps: policy.showFps,
    fontFamilyFallback: policy.fontFamilyFallback,
    keyboardInputEnabled: policy.keyboardInputEnabled,
    keyboardAutofocus: policy.keyboardAutofocus,
    rawTextInputEnabled: policy.rawTextInputEnabled,
    textLayoutCacheCapacity: policy.textLayoutCacheCapacity,
    keyboardButtonMap: policy.keyboardButtonMap,
    allowedPermissions: policy.allowedPermissions,
    pluginFactories: policy.pluginFactories,
    additionalCapabilities: policy.additionalCapabilities,
    recordingFactory: policy.recordingFactory,
    diagnostics: policy.diagnostics ?? diagnostics,
    compositorSurfaces: compositorSurfaces,
    workerHttpOrigins: policy.workerHttpOrigins,
    offloadProviderFactory: policy.offloadProviderFactory,
    memoryLimits: policy.memoryLimits,
    bootstrapMetadataJson: bootstrapMetadataJson,
    bootstrapManifestJson: bootstrapManifestJson,
  );

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
          bootstrapMetadataJson == other.bootstrapMetadataJson &&
          bootstrapManifestJson == other.bootstrapManifestJson &&
          updates == other.updates &&
          downloadOnOpen == other.downloadOnOpen &&
          listEquals(fontFamilyFallback, other.fontFamilyFallback) &&
          memoryLimits == other.memoryLimits &&
          showFps == other.showFps &&
          keyboardInputEnabled == other.keyboardInputEnabled &&
          keyboardAutofocus == other.keyboardAutofocus &&
          rawTextInputEnabled == other.rawTextInputEnabled &&
          textLayoutCacheCapacity == other.textLayoutCacheCapacity &&
          mapEquals(keyboardButtonMap, other.keyboardButtonMap) &&
          recordingFactory == other.recordingFactory &&
          diagnostics == other.diagnostics &&
          offloadProviderFactory == other.offloadProviderFactory &&
          mapEquals(compositorSurfaces, other.compositorSurfaces) &&
          setEquals(workerHttpOrigins, other.workerHttpOrigins) &&
          setEquals(allowedPermissions, other.allowedPermissions) &&
          listEquals(pluginFactories, other.pluginFactories) &&
          setEquals(additionalCapabilities, other.additionalCapabilities);

  @override
  int get hashCode => Object.hashAll(<Object?>[
    appId,
    bytecodeAsset,
    pakAsset,
    metadataAsset,
    manifestAsset,
    bootstrapMetadataJson,
    bootstrapManifestJson,
    updates,
    downloadOnOpen,
    Object.hashAll(fontFamilyFallback),
    memoryLimits,
    showFps,
    keyboardInputEnabled,
    keyboardAutofocus,
    rawTextInputEnabled,
    textLayoutCacheCapacity,
    Object.hashAllUnordered(
      keyboardButtonMap.entries.map((e) => Object.hash(e.key, e.value)),
    ),
    recordingFactory,
    diagnostics,
    offloadProviderFactory,
    Object.hashAllUnordered(workerHttpOrigins),
    Object.hashAllUnordered(
      compositorSurfaces.entries.map((e) => Object.hash(e.key, e.value)),
    ),
    Object.hashAllUnordered(allowedPermissions),
    Object.hashAll(pluginFactories),
    Object.hashAllUnordered(additionalCapabilities),
  ]);
}
