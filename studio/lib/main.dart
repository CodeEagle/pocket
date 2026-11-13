// dart format width=100
import 'package:flutter/material.dart';
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
  runApp(studioApp(studioConfig));
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
/// reach studio.* or clipboard. The slot key exists after the service's first preview publish.
PocketAppConfig studioPreviewChild(PocketStudioConfig config) {
  final key = config.readPreviewKey();
  return PocketAppConfig(
    appId: PocketStudioConfig.previewAppId,
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

Widget studioApp(PocketStudioConfig config, {PocketSystemHostController? controller}) => MaterialApp(
  debugShowCheckedModeBanner: false,
  title: 'Pocket Studio',
  home: PocketSystemHost(
    systemUI: studioSystemUI(config),
    applications: {PocketStudioConfig.previewAppId: studioPreviewChild(config)},
    controller: controller,
  ),
);
