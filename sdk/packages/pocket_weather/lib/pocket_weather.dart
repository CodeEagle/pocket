/// Independently selected weather capabilities using the retained hardware adapter.
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

final class PocketWeatherPlugin extends HardwareCapabilityPlugin {
  PocketWeatherPlugin({
    HardwarePlatform? platform,
    HardwareWeatherFetcher? weatherFetcher,
    Duration requestTimeout = const Duration(seconds: 16),
  }) : super(
         platform: platform,
         weatherFetcher: weatherFetcher,
         requestTimeout: requestTimeout,
         features: const {HardwareFeature.weather},
         pluginId: 'dart.weather',
         includeLegacyPermissions: false,
       );
}
