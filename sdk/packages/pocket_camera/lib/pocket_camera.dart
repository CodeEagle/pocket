/// Independently selected camera capabilities using the retained hardware adapter.
library;

import 'package:pocket_hardware_core/pocket_hardware_core.dart';
export 'package:pocket_hardware_core/pocket_hardware_core.dart'
    show
        HardwarePlatform,
        HardwareStreamingPlatform,
        HardwarePlatformException,
        HardwareCapabilities,
        HardwarePermissions,
        HardwareTextureCallback,
        HardwareWeatherFetcher;

final class PocketCameraPlugin extends HardwareCapabilityPlugin {
  PocketCameraPlugin({
    HardwarePlatform? platform,
    HardwareTextureCallback? onTextureRegistered,
    HardwareTextureCallback? onTextureReleased,
    Duration requestTimeout = const Duration(seconds: 16),
  }) : super(
         platform: platform,
         onTextureRegistered: onTextureRegistered,
         onTextureReleased: onTextureReleased,
         requestTimeout: requestTimeout,
         features: const {HardwareFeature.camera},
         pluginId: 'flutter.camera',
         includeLegacyPermissions: false,
       );
}
