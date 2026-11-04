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
  private var channel: FlutterMethodChannel?
  private var locationManager: CLLocationManager?
  private var pendingLocationResult: FlutterResult?
  private var locationTimeout: DispatchWorkItem?

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
    case "getCurrentLocation": getCurrentLocation(result: result)
    case "disposeSession": disposeSession(result: result)
    default: result(error(code: "hardware_unsupported", message: "unknown location method: \(call.method)"))
    }
  }

  private func ensureLocationManager() -> CLLocationManager {
    if let manager = locationManager { return manager }
    let manager = CLLocationManager()
    manager.delegate = self
    manager.desiredAccuracy = kCLLocationAccuracyBest
    locationManager = manager
    return manager
  }

  private func getCurrentLocation(result: @escaping FlutterResult) {
    main {
      guard CLLocationManager.locationServicesEnabled() else {
        result(self.error(code: "hardware_unsupported", message: "location services are disabled")); return
      }
      guard self.pendingLocationResult == nil else {
        result(self.error(code: "hardware_busy", message: "location request is already pending")); return
      }
      let manager = self.ensureLocationManager()
      guard manager.authorizationStatus == .authorizedAlways || manager.authorizationStatus == .authorizedWhenInUse else {
        result(self.error(code: "hardware_permission_denied", message: "location permission is not granted; request it through the permissions service")); return
      }
      self.pendingLocationResult = result
      let timeout = DispatchWorkItem { [weak self] in
        guard let self = self, let callback = self.pendingLocationResult else { return }
        self.pendingLocationResult = nil; self.locationTimeout = nil
        callback(self.error(code: "hardware_location_timeout", message: "location request timed out"))
      }
      self.locationTimeout = timeout
      DispatchQueue.main.asyncAfter(deadline: .now() + 30, execute: timeout)
      manager.requestLocation()
    }
  }

  func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
    let status = manager.authorizationStatus
    if pendingLocationResult != nil, status == .authorizedWhenInUse || status == .authorizedAlways {
      manager.requestLocation()
      if locationTimeout == nil {
        let timeout = DispatchWorkItem { [weak self] in
          guard let self = self, let callback = self.pendingLocationResult else { return }
          self.pendingLocationResult = nil; self.locationTimeout = nil
          callback(self.error(code: "hardware_location_timeout", message: "no location fix was received"))
        }
        locationTimeout = timeout
        DispatchQueue.main.asyncAfter(deadline: .now() + 30, execute: timeout)
      }
    } else if let callback = pendingLocationResult, status != .notDetermined {
      pendingLocationResult = nil; locationTimeout?.cancel(); locationTimeout = nil
      callback(error(code: "hardware_permission_denied", message: "location permission is denied"))
    }
  }

  func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
    guard let location = locations.last, let callback = pendingLocationResult else { return }
    pendingLocationResult = nil; locationTimeout?.cancel(); locationTimeout = nil
    callback([
      "ok": true, "realGps": true, "latitude": location.coordinate.latitude,
      "longitude": location.coordinate.longitude, "altitudeM": location.altitude,
      "horizontalAccuracyM": location.horizontalAccuracy,
      "timestamp": ISO8601DateFormatter().string(from: location.timestamp),
    ])
  }

  func locationManager(_ manager: CLLocationManager, didFailWithError failure: Error) {
    guard let callback = pendingLocationResult else { return }
    pendingLocationResult = nil; locationTimeout?.cancel(); locationTimeout = nil
    callback(error(code: "hardware_location_error", message: failure.localizedDescription))
  }

  private func disposeSession(result: @escaping FlutterResult) {
    main {
      if let callback = self.pendingLocationResult {
        self.pendingLocationResult = nil; self.locationTimeout?.cancel(); self.locationTimeout = nil
        callback(self.error(code: "plugin_revoked", message: "location session disposed"))
      }
      result(["ok": true, "disposed": true])
    }
  }

  private func main(_ block: @escaping () -> Void) {
    if Thread.isMainThread { block() } else { DispatchQueue.main.async(execute: block) }
  }
  private func error(code: String, message: String) -> [String: Any] { ["ok": false, "errorCode": code, "error": message] }
}
