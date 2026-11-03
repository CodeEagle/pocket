import 'package:flutter/material.dart';
import 'package:pocket_sdk/pocket_sdk.dart';
import 'package:pocket_hardware/pocket_hardware.dart';

void main() {
  WidgetsFlutterBinding.ensureInitialized();
  runApp(
    PocketHostApp(
      recordings: const bool.fromEnvironment('POCKET_RECORD')
          ? PocketRecordingLibrary()
          : null,
    ),
  );
}

/// The showcase consumes the same public SDK used by external applications.
/// All of its pages, routes, themes and transitions are compiled from JS.
const showcaseConfig = PocketAppConfig(
  appId: 'pocket.host.demo',
  updates: PocketUpdateConfig.fromEnvironment(),
  pluginFactories: [createHardwarePlugin],
  allowedPermissions: HardwarePermissions.all,
  showFps: true,
  compositorSurfaces: {
    'pocket.demo.profile': 2,
    'pocket.demo.lobby': 3,
  },
);

final class PocketHostApp extends StatelessWidget {
  const PocketHostApp({super.key, this.systemController, this.recordings});

  final PocketSystemHostController? systemController;
  final PocketRecordingLibrary? recordings;

  @override
  Widget build(BuildContext context) => MaterialApp(
    debugShowCheckedModeBanner: false,
    home: Scaffold(
      body: PocketSystemHost(
        systemUI: showcaseConfig,
        applications: const {
          'pocket.demo.profile': PocketAppConfig(
            appId: 'pocket.demo.profile',
            bytecodeAsset: 'assets/apps/profile/app.qjbc',
            pakAsset: 'assets/apps/profile/app.pak',
            metadataAsset: 'assets/apps/profile/app.bytecode.json',
            manifestAsset: 'assets/apps/profile/guest-manifest.json',
          ),
          'pocket.demo.lobby': PocketAppConfig(
            appId: 'pocket.demo.lobby',
            bytecodeAsset: 'assets/apps/lobby/app.qjbc',
            pakAsset: 'assets/apps/lobby/app.pak',
            metadataAsset: 'assets/apps/lobby/app.bytecode.json',
            manifestAsset: 'assets/apps/lobby/guest-manifest.json',
          ),
        },
        controller: systemController,
        recordings: recordings,
      ),
    ),
  );
}

/// Optional native provider, linked only by consumers that depend on its package.
PocketPlugin createHardwarePlugin(PocketViewController controller) =>
    HardwarePlugin(
      onTextureRegistered: controller.authorizePlatformTexture,
      onTextureReleased: controller.revokePlatformTexture,
    );
