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
    required this.url,
    required this.keyId,
    required this.publicKey,
    this.namespace = 'default',
  });
  const PocketUpdateConfig.fromEnvironment()
    : url = const String.fromEnvironment('POCKET_UPDATE_URL'),
      keyId = const String.fromEnvironment('POCKET_UPDATE_KEY_ID'),
      publicKey = const String.fromEnvironment('POCKET_UPDATE_PUBLIC_KEY'),
      namespace = const String.fromEnvironment(
        'POCKET_STORE_NAMESPACE',
        defaultValue: 'default',
      );
  final String url;
  final String keyId;

  /// Base64-encoded Ed25519 public key.
  final String publicKey;
  final String namespace;
  bool get configured =>
      url.isNotEmpty && keyId.isNotEmpty && publicKey.isNotEmpty;

  void validate() {
    if ((url.isNotEmpty || keyId.isNotEmpty || publicKey.isNotEmpty) &&
        !configured) {
      throw const FormatException(
        'Update URL, key ID and public key must be configured together',
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
          namespace == other.namespace;

  @override
  int get hashCode => Object.hash(url, keyId, publicKey, namespace);
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
  });
  final String appId;
  final String bytecodeAsset;
  final String pakAsset;
  final String metadataAsset;
  final String manifestAsset;
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

  /// Copy this config while replacing the two composable declaration lists.
  ///
  /// The constructor below is the single field-preserving copy boundary used
  /// by host composition and plugin attachment. Omitted lists retain their
  /// existing instances; supplied iterables are snapshotted.
  PocketAppConfig copyWith({
    Iterable<PocketPluginFactory>? pluginFactories,
    Iterable<String>? additionalCapabilities,
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
    recordingFactory: recordingFactory,
    compositorSurfaces: compositorSurfaces,
    workerHttpOrigins: workerHttpOrigins,
    offloadProviderFactory: offloadProviderFactory,
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
