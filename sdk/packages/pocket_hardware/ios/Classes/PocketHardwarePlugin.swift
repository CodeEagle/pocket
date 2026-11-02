import Flutter

/// Standard Flutter plugin entry point for the compiled-in hardware provider.
///
/// The manager remains a single process-local provider so deactivation can
/// stop camera/BLE/location/sensor resources before a guest cutover.
public final class PocketHardwarePlugin: NSObject, FlutterPlugin {
  public static func register(with registrar: FlutterPluginRegistrar) {
    PocketHardwareManager.shared.attach(registrar: registrar)
  }
}
