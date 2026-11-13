import 'dart:convert';
import 'dart:io';

import 'package:crypto/crypto.dart';

/// Trusted host configuration for the Studio provider. It is supplied by the
/// host's build/run configuration (dart-define) and never by the guest.
final class PocketStudioConfig {
  PocketStudioConfig({
    required this.port,
    this.sdkRoot,
    this.projectRoot,
    this.workspace,
    this.autoStart = true,
    this.bunExecutable = 'bun',
    this.hostVersion = 'studio',
    this.extraProjectRoots = const <String>[],
    this.updateChannel = 'test',
    this.startTimeout = const Duration(seconds: 90),
    this.environment = const <String, String>{},
  }) {
    if (port < 1 || port > 65535) {
      throw ArgumentError.value(port, 'port', 'must be 1..65535');
    }
    if (updateChannel != 'test' && updateChannel != 'stable') {
      throw ArgumentError.value(updateChannel, 'updateChannel', 'must be test or stable');
    }
  }

  factory PocketStudioConfig.fromEnvironment() {
    const port = int.fromEnvironment('POCKET_STUDIO_PORT', defaultValue: 8795);
    const sdk = String.fromEnvironment('POCKET_STUDIO_SDK_ROOT');
    const project = String.fromEnvironment('POCKET_STUDIO_PROJECT_ROOT');
    const workspace = String.fromEnvironment('POCKET_STUDIO_WORKSPACE');
    const bun = String.fromEnvironment('POCKET_STUDIO_BUN', defaultValue: 'bun');
    const autoStart = bool.fromEnvironment('POCKET_STUDIO_AUTOSTART', defaultValue: true);
    const extraRoots = String.fromEnvironment('POCKET_STUDIO_EXTRA_PROJECT_ROOTS');
    const channel = String.fromEnvironment('POCKET_STUDIO_UPDATE_CHANNEL', defaultValue: 'test');
    return PocketStudioConfig(
      port: port,
      sdkRoot: sdk.isEmpty ? null : sdk,
      projectRoot: project.isEmpty ? null : project,
      workspace: workspace.isEmpty ? null : workspace,
      bunExecutable: bun,
      autoStart: autoStart,
      extraProjectRoots: extraRoots.isEmpty ? const <String>[] : extraRoots.split(':'),
      updateChannel: channel,
    );
  }

  final int port;
  final String? sdkRoot;
  final String? projectRoot;
  final String? workspace;
  final bool autoStart;
  final String bunExecutable;

  /// Update host version segment passed to the service; fixes the preview slot URL.
  final String hostVersion;

  /// Additional trusted project roots the service lists next to [projectRoot] (for example the Studio's own
  /// guest project). Host configuration only; ':' separated in `POCKET_STUDIO_EXTRA_PROJECT_ROOTS`.
  final List<String> extraProjectRoots;

  /// Slot the Studio updates itself from: `test` (default) or `stable`.
  final String updateChannel;
  final Duration startTimeout;
  final Map<String, String> environment;

  Uri get origin => Uri(scheme: 'http', host: '127.0.0.1', port: port);

  /// Service workspace directory (host side only).
  String? get effectiveWorkspace =>
      workspace ?? (projectRoot == null ? null : '$projectRoot/.pocket-editor');

  /// Fixed preview child package id (STUDIO_SIGNED_PREVIEW.md).
  static const String previewAppId = 'dev.pocket.studio.preview';

  /// Bootstrap metadata the preview child needs before any package exists: this host's runtime ABI and a
  /// build floor of 1, so any signed preview (build >= 2) is admitted. The executable bytes and manifest
  /// come only from the signed package.
  static String previewBootstrap(String studioMetadataJson) {
    final studio = jsonDecode(studioMetadataJson) as Map<String, dynamic>;
    return jsonEncode({
      'runtimeAbi': studio['runtimeAbi'],
      'entryFormat': 'quickjs-bytecode',
      'version': 'bootstrap',
      'build': 1,
    });
  }

  /// The Studio's own app id (its guest project's `appId`, the SystemUI of the host).
  static const String studioAppId = 'dev.pocket.studio';

  /// Package index of the service's signed slot for the Studio's own project ([updateChannel]).
  String get selfUpdateUrl => '$origin/$updateChannel/pocket/$hostVersion/$studioAppId/latest.json';

  /// Host-store namespace of the preview child, scoped to the preview signing key. A new workspace (new key)
  /// or a reset service-side counter then starts from a fresh anti-downgrade floor instead of colliding
  /// with a machine-global one.
  String previewNamespace(String publicKey) =>
      'studio-preview-${sha256.convert(utf8.encode(publicKey)).toString().substring(0, 12)}';

  /// Signed update URL of the service's preview slot.
  String get previewUpdateUrl =>
      '$origin/preview/pocket/$hostVersion/$previewAppId/preview/latest.json';

  /// Public preview signing key written by the service at startup, read from the trusted workspace.
  ({String keyId, String publicKey})? readPreviewKey() => _readPublicKey('editor-preview-key.json');

  /// Public update signing key (the key the service signs test and stable publishes with, public half only).
  /// The service provisions it at startup (`--provision-update-key`), so the Studio's own update slot is
  /// configured before its first publish, exactly like [readPreviewKey] for the preview child.
  ({String keyId, String publicKey})? readUpdateKey() => _readPublicKey('editor-dev-key.json');

  ({String keyId, String publicKey})? _readPublicKey(String name) {
    final dir = effectiveWorkspace;
    if (dir == null) return null;
    try {
      final file = File('$dir/keys/$name');
      if (!file.existsSync()) return null;
      final json = jsonDecode(file.readAsStringSync()) as Map<String, dynamic>;
      final id = json['keyId'];
      final key = json['publicKeyBase64'];
      if (id is String && key is String) return (keyId: id, publicKey: key);
    } on Object {
      // Treated as "not created yet".
    }
    return null;
  }
}
