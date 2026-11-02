import 'package:pocket_flutter/pocket_flutter.dart';
import 'package:pocket_services/pocket_services.dart';

/// A new provider instance is created for each verified guest generation.
typedef PocketPluginFactory =
    PocketPlugin Function(PocketViewController controller);

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
    this.enableHardware = false,
    this.showFps = false,
    this.allowedPermissions = const {},
    this.pluginFactories = const [],
    this.additionalCapabilities = const {},
  });
  final String appId;
  final String bytecodeAsset;
  final String pakAsset;
  final String metadataAsset;
  final String manifestAsset;
  final PocketUpdateConfig? updates;

  /// Makes the compiled hardware provider available. OS permissions are still
  /// requested only by an explicit guest action and host admission policy.
  final bool enableHardware;
  final bool showFps;
  final Set<String> allowedPermissions;
  final List<PocketPluginFactory> pluginFactories;
  final Set<String> additionalCapabilities;

  void validate() {
    if (!RegExp(r'^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$').hasMatch(appId)) {
      throw const FormatException('Invalid Pocket application ID');
    }
    updates?.validate();
  }
}
