import Flutter
import Foundation

public final class PocketBluetoothPlugin: NSObject, FlutterPlugin, FlutterStreamHandler {
  private let core = PocketBluetoothCore.shared
  private var eventChannel: FlutterEventChannel?

  public static func register(with registrar: FlutterPluginRegistrar) {
    let instance = PocketBluetoothPlugin()
    let channel = FlutterMethodChannel(
      name: "com.pocketnexus.host/hardware/bluetooth",
      binaryMessenger: registrar.messenger()
    )
    registrar.addMethodCallDelegate(instance, channel: channel)
    let events = FlutterEventChannel(
      name: "com.pocketnexus.host/hardware/bluetooth/events",
      binaryMessenger: registrar.messenger()
    )
    events.setStreamHandler(instance)
    instance.eventChannel = events
  }

  public func handle(_ call: FlutterMethodCall, result: @escaping FlutterResult) {
    core.handle(method: call.method, args: call.arguments as? [String: Any] ?? [:]) { payload in
      // Preserve the existing iOS channel contract: native failures are
      // structured dictionaries, not FlutterError envelopes. JS callers use
      // errorCode/error alongside ok=false for parity with the local helper.
      result(payload)
    }
  }

  public func onListen(withArguments arguments: Any?, eventSink events: @escaping FlutterEventSink) -> FlutterError? {
    core.setEventSink { packet in events(packet) }
    return nil
  }

  public func onCancel(withArguments arguments: Any?) -> FlutterError? {
    core.setEventSink(nil)
    return nil
  }

  deinit {
    core.setEventSink(nil)
    core.dispose()
    eventChannel?.setStreamHandler(nil)
  }
}
