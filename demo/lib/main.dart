import 'package:flutter/material.dart';
import 'package:pocket_sdk/pocket_sdk.dart';
import 'package:pocket_hardware/pocket_hardware.dart';

void main() {
  WidgetsFlutterBinding.ensureInitialized();
  runApp(const PocketHostApp());
}

/// The showcase consumes the same public SDK used by external applications.
/// All of its pages, routes, themes and transitions are compiled from JS.
const showcaseConfig = PocketAppConfig(
  appId: 'pocket.host.demo',
  updates: PocketUpdateConfig.fromEnvironment(),
  pluginFactories: [createHardwarePlugin],
  allowedPermissions: HardwarePermissions.all,
  showFps: true,
);

final class PocketHostApp extends StatelessWidget {
  const PocketHostApp({super.key});

  @override
  Widget build(BuildContext context) => const PocketApp(config: showcaseConfig);
}

/// Optional native provider, linked only by consumers that depend on its package.
PocketPlugin createHardwarePlugin(PocketViewController controller) =>
    HardwarePlugin(
      onTextureRegistered: controller.authorizePlatformTexture,
      onTextureReleased: controller.revokePlatformTexture,
    );
