// dart format width=100
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart' show rootBundle;
import 'package:pocket_clipboard/pocket_clipboard.dart';
import 'package:pocket_sdk/pocket_sdk.dart';
import 'package:pocket_studio/pocket_studio.dart';

const studioAppId = 'dev.pocket.studio';

/// Trusted build/run configuration (dart-define); the guest never supplies it.
final studioConfig = PocketStudioConfig.fromEnvironment();
final studioService = PocketStudioService(studioConfig);

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  await studioService.start(); // attach to a healthy service or spawn one; stops on exit
  // The service creates the preview signing key at startup, so the preview child is fully
  // configured before the first publish. Its bootstrap carries only the runtime ABI of this host.
  final bootstrap = previewBootstrap(await rootBundle.loadString('assets/app.bytecode.json'));
  runApp(studioApp(studioConfig, previewBootstrapMetadata: bootstrap));
}

/// The Studio guest is the only app granted studio.* and clipboard capabilities.
PocketAppConfig studioSystemUI(PocketStudioConfig config) => PocketAppConfig(
  appId: studioAppId,
  allowedPermissions: {...PocketStudioPermissions.all, 'clipboard.read', 'clipboard.write'},
  pluginFactories: [(_) => PocketStudioPlugin(config: config), (_) => PocketClipboardPlugin()],
  additionalCapabilities: {'ui.compositor-surfaces'},
  compositorSurfaces: {PocketStudioConfig.previewAppId: 4},
  rawTextInputEnabled: true, // guest-requested raw key/IME sessions for the M4 code editor
  memoryLimits: PocketMemoryLimits(
    heapLimitBytes: PocketMemoryLimits.maximumHeapBytes, // top QuickJS tier (2 GiB ceiling)
    maxPakBytes: 32 * 1024 * 1024,
  ),
);

/// Preview child: signed update slot only. No allowedPermissions and no plugins, so it can never
/// reach studio.* or clipboard. The service creates the preview key at startup (before any publish).
PocketAppConfig studioPreviewChild(PocketStudioConfig config, {String? previewBootstrapMetadata}) {
  final key = config.readPreviewKey();
  return PocketAppConfig(
    appId: PocketStudioConfig.previewAppId,
    bootstrapMetadataJson: previewBootstrapMetadata,
    bootstrapManifestJson: previewBootstrapMetadata == null ? null : _previewBootstrapManifest,
    downloadOnOpen: key != null,
    updates: key == null
        ? null
        : PocketUpdateConfig(
            url: config.previewUpdateUrl,
            keyId: key.keyId,
            publicKey: key.publicKey,
            namespace: 'studio-preview',
            debugHttpHosts: const ['127.0.0.1'],
          ),
  );
}

const _previewBootstrapManifest = '{"protocolVersion":1,"capabilities":{"requires":[],"optional":[]}}';

/// Bootstrap metadata of the preview child: this host's runtime ABI and a build floor of 1, so any
/// signed preview (build >= 2) is admitted. The executable bytes and manifest come only from the
/// signed package.
String previewBootstrap(String studioMetadataJson) {
  final studio = jsonDecode(studioMetadataJson) as Map<String, dynamic>;
  return jsonEncode({
    'runtimeAbi': studio['runtimeAbi'],
    'entryFormat': 'quickjs-bytecode',
    'version': 'bootstrap',
    'build': 1,
  });
}

Widget studioApp(
  PocketStudioConfig config, {
  PocketSystemHostController? controller,
  String? previewBootstrapMetadata,
}) => MaterialApp(
  debugShowCheckedModeBanner: false,
  title: 'Pocket Studio',
  home: PocketSystemHost(
    systemUI: studioSystemUI(config),
    applications: {
      PocketStudioConfig.previewAppId: studioPreviewChild(
        config,
        previewBootstrapMetadata: previewBootstrapMetadata,
      ),
    },
    controller: controller,
  ),
);
