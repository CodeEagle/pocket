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
      url.isNotEmpty &&
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
  bool get configured =>
      (url.isNotEmpty && keyId.isNotEmpty && publicKey.isNotEmpty) ||
      trustPolicyConfigured;

  void validate() {
    final hasLegacy =
        keyId.isNotEmpty || publicKey.isNotEmpty;
    final hasTrust =
        trustRootKeyId?.isNotEmpty == true ||
        trustRootPublicKey?.isNotEmpty == true ||
        trustPolicyUrl?.isNotEmpty == true;
    final legacyComplete =
        url.isNotEmpty && keyId.isNotEmpty && publicKey.isNotEmpty;
    if ((hasLegacy && !legacyComplete) ||
        (hasTrust && !trustPolicyConfigured) ||
        (url.isNotEmpty && !legacyComplete && !trustPolicyConfigured)) {
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
  final PocketUpdateConfig? updates;

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
  }) => PocketAppConfig(
    appId: appId,
    bytecodeAsset: bytecodeAsset,
    pakAsset: pakAsset,
    metadataAsset: metadataAsset,
    manifestAsset: manifestAsset,
    updates: updates,
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
