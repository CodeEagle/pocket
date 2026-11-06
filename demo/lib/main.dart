import 'package:flutter/material.dart';
import 'package:pocket_sdk/pocket_sdk.dart';
import 'package:pocket_hardware/pocket_hardware.dart';
import 'package:pocket_platform/pocket_platform.dart';
import 'flutter_frame_monitor.dart';
Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  PocketHostConfig? config;
  Object? error;
  try {
    config = await PocketHostConfig.loadFromEnvironment();
  } catch (cause) {
    error = cause;
  }
  runApp(PocketHostApp(hostConfig: config, hostConfigError: error));
}
const showcaseConfig = PocketAppConfig(
  appId: 'pocket.host.demo',
  updates: PocketUpdateConfig.fromEnvironment(),
  pluginFactories: [createHardwarePlugin, createPlatformPlugin],
  allowedPermissions: HardwarePermissions.all,
  additionalCapabilities: {'ui.compositor-surfaces'},
  memoryLimits: PocketMemoryLimits(heapLimitBytes: 128 * 1024 * 1024, maxPakBytes: 8 * 1024 * 1024),
  compositorSurfaces: {'pocket.demo.profile': 2, 'pocket.demo.lobby': 3},
);
const showcaseApplications = <String, PocketAppConfig>{
  'pocket.demo.profile': PocketAppConfig(
    appId: 'pocket.demo.profile',
    memoryLimits: PocketMemoryLimits(heapLimitBytes: 128 * 1024 * 1024),
    bytecodeAsset: 'assets/apps/profile/app.qjbc',
    pakAsset: 'assets/apps/profile/app.pak',
    metadataAsset: 'assets/apps/profile/app.bytecode.json',
    manifestAsset: 'assets/apps/profile/guest-manifest.json',
  ),
  'pocket.demo.lobby': PocketAppConfig(
    appId: 'pocket.demo.lobby',
    memoryLimits: PocketMemoryLimits(maxPakBytes: 8 * 1024 * 1024),
    bytecodeAsset: 'assets/apps/lobby/app.qjbc',
    pakAsset: 'assets/apps/lobby/app.pak',
    metadataAsset: 'assets/apps/lobby/app.bytecode.json',
    manifestAsset: 'assets/apps/lobby/guest-manifest.json',
  ),
};
final class PocketHostApp extends StatelessWidget {
  const PocketHostApp({
    super.key,
    this.systemController,
    this.recordings,
    this.hostConfig,
    this.hostConfigError,
    this.frameMonitorController,
    this.showFlutterFps = const bool.fromEnvironment('FLUTTER_FPS'),
  });
  final PocketSystemHostController? systemController;
  final PocketRecordingLibrary? recordings;
  final PocketHostConfig? hostConfig;
  final Object? hostConfigError;
  final FlutterFrameMonitorController? frameMonitorController;
  final bool showFlutterFps;
  @override
  Widget build(BuildContext context) {
    final error = hostConfigError;
    final remote = hostConfig;
    final host = error != null
        ? Center(child: SelectableText('Pocket host config failed: $error'))
        : remote == null
        ? PocketSystemHost(
            systemUI: showcaseConfig,
            applications: showcaseApplications,
            controller: systemController,
            recordings: recordings,
          )
        : PocketSystemHost.fromHostConfig(
            config: remote,
            controller: systemController,
            recordings: recordings,
            approveSystemUI: (app) => app.withNativePolicy(showcaseConfig),
            approveApplication: (id, app) =>
                app.withNativePolicy(showcaseApplications[id] ?? PocketAppConfig(appId: id)),
          );
    return MaterialApp(
      debugShowCheckedModeBanner: false,
      showPerformanceOverlay: const bool.fromEnvironment('FLUTTER_PERFORMANCE_OVERLAY'),
      builder: (context, child) => FlutterFrameMonitor(
        enabled: showFlutterFps,
        controller: frameMonitorController,
        child: child ?? const SizedBox.shrink(),
      ),
      home: Scaffold(backgroundColor: error == null ? null : Colors.black, body: host),
    );
  }
}
PocketPlugin createHardwarePlugin(PocketViewController controller) => HardwarePlugin(
  onTextureRegistered: controller.authorizePlatformTexture,
  onTextureReleased: controller.revokePlatformTexture,
);
PocketPlugin createPlatformPlugin(PocketViewController controller) => PocketPlatformPlugin();
