import CoreLocation
import Flutter
import Foundation

/// Independent iOS transport for the location capability group.
public final class PocketLocationPlugin: NSObject, FlutterPlugin {
  public static func register(with registrar: FlutterPluginRegistrar) {
    PocketLocationManager.shared.attach(registrar: registrar)
  }
}

private final class PocketLocationManager: NSObject, CLLocationManagerDelegate {
  static let shared = PocketLocationManager()
  private let channelName = "com.pocketnexus.host/hardware/location"
  private let legacySessionId = "legacy"
  private var channel: FlutterMethodChannel?
  private var locationManager: CLLocationManager?
  private var pendingLocationResult: FlutterResult?
  private var pendingLocationSessionId: String?
  private var locationTimeout: DispatchWorkItem?

  private override init() { super.init() }

  func attach(registrar: FlutterPluginRegistrar) {
    if channel != nil { return }
    let methodChannel = FlutterMethodChannel(name: channelName, binaryMessenger: registrar.messenger())
    channel = methodChannel
    methodChannel.setMethodCallHandler { [weak self] call, result in self?.handle(call, result: result) }
  }

  func detach() {
    disposeNativeResources(reason: "plugin detached") {
      self.channel?.setMethodCallHandler(nil)
      self.channel = nil
    }
  }

  private func handle(_ call: FlutterMethodCall, result: @escaping FlutterResult) {
    switch call.method {
    case "getCurrentLocation":
      let args = call.arguments as? [String: Any] ?? [:]
      getCurrentLocation(sessionId: args["sessionId"] as? String, result: result)
    case "disposeSession":
      let args = call.arguments as? [String: Any] ?? [:]
      disposeSession(sessionId: args["sessionId"] as? String, result: result)
    default: result(error(code: "hardware_unsupported", message: "unknown location method: \(call.method)"))
    }
  }

  private func makeLocationManager() -> CLLocationManager {
    let manager = CLLocationManager()
    manager.delegate = self
    manager.desiredAccuracy = kCLLocationAccuracyBest
    return manager
  }

  private func getCurrentLocation(sessionId: String?, result: @escaping FlutterResult) {
    main {
      guard CLLocationManager.locationServicesEnabled() else {
        result(self.error(code: "hardware_unsupported", message: "location services are disabled")); return
      }
      guard self.pendingLocationResult == nil else {
        result(self.error(code: "hardware_busy", message: "location request is already pending")); return
      }
      let manager = self.makeLocationManager()
      guard manager.authorizationStatus == .authorizedAlways || manager.authorizationStatus == .authorizedWhenInUse else {
        result(self.error(code: "hardware_permission_denied", message: "location permission is not granted; request it through the permissions service")); return
      }
      self.locationManager = manager
      self.pendingLocationResult = result
      self.pendingLocationSessionId = self.normalizeSessionId(sessionId)
      let timeout = DispatchWorkItem { [weak self, weak manager] in
        guard let self = self, let manager = manager else { return }
        self.finishLocation(
          manager: manager,
          value: self.error(code: "hardware_location_timeout", message: "location request timed out"),
        )
      }
      self.locationTimeout = timeout
      DispatchQueue.main.asyncAfter(deadline: .now() + 30, execute: timeout)
      manager.requestLocation()
    }
  }

  func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
    guard let activeManager = locationManager, activeManager === manager else { return }
    let status = manager.authorizationStatus
    if status == .denied || status == .restricted {
      finishLocation(
        manager: manager,
        value: error(code: "hardware_permission_denied", message: "location permission is denied"),
      )
    }
  }

  func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
    guard let location = locations.last else { return }
    finishLocation(manager: manager, value: [
      "ok": true, "realGps": true, "latitude": location.coordinate.latitude,
      "longitude": location.coordinate.longitude, "altitudeM": location.altitude,
      "horizontalAccuracyM": location.horizontalAccuracy,
      "timestamp": ISO8601DateFormatter().string(from: location.timestamp),
    ])
  }

  func locationManager(_ manager: CLLocationManager, didFailWithError failure: Error) {
    finishLocation(
      manager: manager,
      value: error(code: "hardware_location_error", message: failure.localizedDescription),
    )
  }

  private func disposeSession(sessionId: String?, result: @escaping FlutterResult) {
    main {
      let ownerSessionId = self.normalizeSessionId(sessionId)
      self.cancelLocation(
        reason: "location session disposed",
        ownerSessionId: ownerSessionId,
        includeAll: false,
      )
      result(["ok": true, "disposed": true, "sessionId": ownerSessionId])
    }
  }

  private func disposeNativeResources(reason: String, completion: (() -> Void)? = nil) {
    main {
      self.cancelLocation(reason: reason, ownerSessionId: nil, includeAll: true)
      completion?()
    }
  }

  private func cancelLocation(reason: String, ownerSessionId: String?, includeAll: Bool) {
    guard includeAll || pendingLocationSessionId == ownerSessionId else { return }
    guard let manager = locationManager else { return }
    finishLocation(
      manager: manager,
      value: error(code: "plugin_revoked", message: reason),
    )
  }

  private func normalizeSessionId(_ value: String?) -> String {
    let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    return trimmed.isEmpty ? legacySessionId : trimmed
  }

  private func finishLocation(
    manager: CLLocationManager,
    value: [String: Any],
  ) {
    guard let activeManager = locationManager, activeManager === manager else { return }
    guard let callback = pendingLocationResult else { return }
    activeManager.stopUpdatingLocation()
    activeManager.delegate = nil
    locationManager = nil
    pendingLocationResult = nil
    pendingLocationSessionId = nil
    locationTimeout?.cancel(); locationTimeout = nil
    callback(value)
  }

  private func main(_ block: @escaping () -> Void) {
    if Thread.isMainThread { block() } else { DispatchQueue.main.async(execute: block) }
  }
  private func error(code: String, message: String) -> [String: Any] { ["ok": false, "errorCode": code, "error": message] }
}
