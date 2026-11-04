import Flutter
import Foundation
import LocalAuthentication

/// Independent iOS transport for the biometrics capability group.
public final class PocketBiometricsPlugin: NSObject, FlutterPlugin {
  public static func register(with registrar: FlutterPluginRegistrar) {
    PocketBiometricsManager.shared.attach(registrar: registrar)
  }
}

private final class PocketBiometricsManager: NSObject {
  static let shared = PocketBiometricsManager()
  private let channelName = "com.pocketnexus.host/hardware/biometrics"
  private var channel: FlutterMethodChannel?
  private var activeBiometricContext: LAContext?
  private var pendingResult: FlutterResult?

  private override init() { super.init() }

  func attach(registrar: FlutterPluginRegistrar) {
    if channel != nil { return }
    let methodChannel = FlutterMethodChannel(name: channelName, binaryMessenger: registrar.messenger())
    channel = methodChannel
    methodChannel.setMethodCallHandler { [weak self] call, result in self?.handle(call, result: result) }
  }

  func detach() {
    disposeSession { _ in
      self.channel?.setMethodCallHandler(nil)
      self.channel = nil
    }
  }

  private func handle(_ call: FlutterMethodCall, result: @escaping FlutterResult) {
    switch call.method {
    case "authenticateBiometrics":
      let args = call.arguments as? [String: Any] ?? [:]
      authenticateBiometrics(reason: args["reason"] as? String ?? "Authenticate to continue", result: result)
    case "disposeSession": disposeSession(result: result)
    default: result(error(code: "hardware_unsupported", message: "unknown biometric method: \(call.method)"))
    }
  }

  private func authenticateBiometrics(reason: String, result: @escaping FlutterResult) {
    guard !reason.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
      result(error(code: "invalid_argument", message: "biometric reason must not be empty")); return
    }
    guard pendingResult == nil else {
      result(error(code: "hardware_busy", message: "biometric authentication is already running")); return
    }
    let context = LAContext()
    var authError: NSError?
    guard context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &authError) else {
      result(error(code: "hardware_unsupported", message: authError?.localizedDescription ?? "biometrics are unavailable")); return
    }
    activeBiometricContext = context
    pendingResult = result
    let type: String
    switch context.biometryType { case .faceID: type = "FaceID"; case .touchID: type = "TouchID"; default: type = "unknown" }
    context.evaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, localizedReason: reason) { [weak self] success, failure in
      guard let self = self else { return }
      self.main {
        guard self.activeBiometricContext === context else { return }
        guard let callback = self.pendingResult else { return }
        self.pendingResult = nil; self.activeBiometricContext = nil
        var response: [String: Any] = ["ok": true, "authenticated": success, "realBiometrics": true, "biometricType": type]
        if let failure = failure { response["errorCode"] = "hardware_biometric_failed"; response["error"] = failure.localizedDescription }
        callback(response)
      }
    }
  }

  private func disposeSession(result: @escaping FlutterResult) {
    main {
      self.activeBiometricContext?.invalidate()
      self.activeBiometricContext = nil
      if let callback = self.pendingResult {
        self.pendingResult = nil
        callback(self.error(code: "plugin_revoked", message: "biometric session disposed"))
      }
      result(["ok": true, "disposed": true])
    }
  }

  private func main(_ block: @escaping () -> Void) {
    if Thread.isMainThread { block() } else { DispatchQueue.main.async(execute: block) }
  }
  private func error(code: String, message: String) -> [String: Any] { ["ok": false, "errorCode": code, "error": message] }
}
