import Flutter

/// Standard Flutter plugin entry point for PocketView's optional native
/// display geometry bridge.
public final class PocketFlutterPlugin: NSObject, FlutterPlugin {
  public static func register(with registrar: FlutterPluginRegistrar) {
    PocketDisplayGeometry.shared.attach(registrar: registrar)
  }
}
