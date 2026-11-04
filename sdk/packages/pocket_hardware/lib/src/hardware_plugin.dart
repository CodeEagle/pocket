import 'package:pocket_hardware_core/pocket_hardware_core.dart';
import 'package:pocket_permissions/pocket_permissions.dart';
export 'package:pocket_hardware_core/pocket_hardware_core.dart';

/// Compatibility aggregate. New consumers can select individual capability
/// packages and register pocket_permissions only for OS permissions they need.
final class HardwarePlugin extends HardwareCapabilityPlugin {
  HardwarePlugin({
    HardwarePlatform? platform,
    PocketSystemPermissions? systemPermissions,
    HardwareWeatherFetcher? weatherFetcher,
    HardwareTextureCallback? onTextureRegistered,
    HardwareTextureCallback? onTextureReleased,
    Duration requestTimeout = const Duration(seconds: 16),
    Set<String>? grantedPermissions,
  }) : super(
         platform: platform,
         permissionHandler: _handler(
           systemPermissions ?? PocketSystemPermissions(),
         ),
         weatherFetcher: weatherFetcher,
         onTextureRegistered: onTextureRegistered,
         onTextureReleased: onTextureReleased,
         requestTimeout: requestTimeout,
         grantedPermissions: grantedPermissions,
         includeLegacyPermissions: true,
       );

  static HardwarePermissionHandler _handler(PocketSystemPermissions service) =>
      (permission, {required request}) =>
          request ? service.request(permission) : service.status(permission);
}
