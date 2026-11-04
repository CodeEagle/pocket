/// Independently selected sensors capabilities using the retained hardware adapter.
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

final class PocketSensorsPlugin extends HardwareCapabilityPlugin {
  PocketSensorsPlugin({
    HardwarePlatform? platform,
    Duration requestTimeout = const Duration(seconds: 16),
  }) : super(
         platform: platform,
         requestTimeout: requestTimeout,
         features: const {HardwareFeature.sensors},
         pluginId: 'flutter.sensors',
         includeLegacyPermissions: false,
       );
}
