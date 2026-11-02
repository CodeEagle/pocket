import 'package:flutter/material.dart';
import 'package:pocket_sdk/pocket_sdk.dart';

void main() {
  WidgetsFlutterBinding.ensureInitialized();
  runApp(const PocketHostApp());
}

/// The showcase consumes the same public SDK used by external applications.
/// All of its pages, routes, themes and transitions are compiled from JS.
const showcaseConfig = PocketAppConfig(
  appId: 'pocket.host.demo',
  updates: PocketUpdateConfig.fromEnvironment(),
  enableHardware: true,
  allowedPermissions: HardwarePermissions.all,
  showFps: true,
);

final class PocketHostApp extends StatelessWidget {
  const PocketHostApp({super.key});

  @override
  Widget build(BuildContext context) => const PocketApp(config: showcaseConfig);
}
