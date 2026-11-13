import 'dart:convert';
import 'dart:io';

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
    this.startTimeout = const Duration(seconds: 90),
    this.environment = const <String, String>{},
  }) {
    if (port < 1 || port > 65535) {
      throw ArgumentError.value(port, 'port', 'must be 1..65535');
    }
  }

  factory PocketStudioConfig.fromEnvironment() {
    const port = int.fromEnvironment('POCKET_STUDIO_PORT', defaultValue: 8795);
    const sdk = String.fromEnvironment('POCKET_STUDIO_SDK_ROOT');
    const project = String.fromEnvironment('POCKET_STUDIO_PROJECT_ROOT');
    const workspace = String.fromEnvironment('POCKET_STUDIO_WORKSPACE');
    const bun = String.fromEnvironment('POCKET_STUDIO_BUN', defaultValue: 'bun');
    const autoStart = bool.fromEnvironment('POCKET_STUDIO_AUTOSTART', defaultValue: true);
    return PocketStudioConfig(
      port: port,
      sdkRoot: sdk.isEmpty ? null : sdk,
      projectRoot: project.isEmpty ? null : project,
      workspace: workspace.isEmpty ? null : workspace,
      bunExecutable: bun,
      autoStart: autoStart,
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
  final Duration startTimeout;
  final Map<String, String> environment;

  Uri get origin => Uri(scheme: 'http', host: '127.0.0.1', port: port);

  /// Service workspace directory (host side only).
  String? get effectiveWorkspace =>
      workspace ?? (projectRoot == null ? null : '$projectRoot/.pocket-editor');

  /// Fixed preview child package id (STUDIO_SIGNED_PREVIEW.md).
  static const String previewAppId = 'dev.pocket.studio.preview';

  /// Signed update URL of the service's preview slot.
  String get previewUpdateUrl =>
      '$origin/preview/pocket/$hostVersion/$previewAppId/preview/latest.json';

  /// Public preview signing key written by the service on its first preview
  /// publish, read from the trusted workspace. Null until then.
  ({String keyId, String publicKey})? readPreviewKey() {
    final dir = effectiveWorkspace;
    if (dir == null) return null;
    try {
      final file = File('$dir/keys/editor-preview-key.json');
      if (!file.existsSync()) return null;
      final json = jsonDecode(file.readAsStringSync()) as Map<String, dynamic>;
      final id = json['keyId'];
      final key = json['publicKeyBase64'];
      if (id is String && key is String) return (keyId: id, publicKey: key);
    } on Object {
      // Treated as "not published yet".
    }
    return null;
  }
}
