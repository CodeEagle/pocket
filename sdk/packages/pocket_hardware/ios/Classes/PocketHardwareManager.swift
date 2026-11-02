import AVFoundation
import AVFAudio
import CoreBluetooth
import CoreLocation
import CoreMotion
import Flutter
import ImageIO
import LocalAuthentication
import Photos
import UIKit

/// The iOS side of the compiled-in `flutter.hardware` provider.
///
/// This class deliberately returns an explicit error when a capability is not
/// available.  It never returns fixture values, simulated peripherals, or a
/// fake camera frame.  JS owns the page and registers the returned camera
/// texture as a compositor surface; this class owns only native resources.
final class PocketHardwareManager: NSObject,
  AVCaptureVideoDataOutputSampleBufferDelegate,
  AVCapturePhotoCaptureDelegate,
  CBCentralManagerDelegate,
  CBPeripheralDelegate,
  CLLocationManagerDelegate
{
  static let shared = PocketHardwareManager()

  private let channelName = "com.pocketnexus.host/hardware"
  private var channel: FlutterMethodChannel?
  private weak var textureRegistry: FlutterTextureRegistry?

  private let cameraQueue = DispatchQueue(
    label: "com.pocketnexus.host.hardware.camera",
    qos: .userInitiated
  )
  private var captureSession: AVCaptureSession?
  private var cameraInput: AVCaptureDeviceInput?
  private var videoOutput: AVCaptureVideoDataOutput?
  private var photoOutput: AVCapturePhotoOutput?
  private var cameraDevice: AVCaptureDevice?
  private var cameraPosition: AVCaptureDevice.Position = .back
  private var flashMode: AVCaptureDevice.FlashMode = .off
  private var cameraTexture: PocketHardwareTexture?
  private var textureId: Int64?
  private var pendingPhotoResult: FlutterResult?
  private var activeBiometricContext: LAContext?

  private let bleQueue = DispatchQueue(
    label: "com.pocketnexus.host.hardware.bluetooth",
    qos: .userInitiated
  )
  private var central: CBCentralManager?
  private var discovered: [String: CBPeripheral] = [:]
  private var discoveredInfo: [String: [String: Any]] = [:]
  private var pendingScanResult: FlutterResult?
  private var scanTimeout: DispatchWorkItem?
  private var pendingConnections: [String: FlutterResult] = [:]
  private var connectionTimeouts: [String: DispatchWorkItem] = [:]

  private var locationManager: CLLocationManager?
  private var pendingPermissionResult: FlutterResult?
  private var pendingLocationResult: FlutterResult?
  private var locationTimeout: DispatchWorkItem?

  private let sensorQueue: OperationQueue = {
    let queue = OperationQueue()
    queue.name = "com.pocketnexus.host.hardware.sensors"
    queue.qualityOfService = .utility
    queue.maxConcurrentOperationCount = 1
    return queue
  }()
  private lazy var motionManager = CMMotionManager()
  private lazy var altimeter = CMAltimeter()

  private override init() {
    super.init()
  }

  func attach(registrar: FlutterPluginRegistrar) {
    if channel != nil { return }
    textureRegistry = registrar.textures()
    let methodChannel = FlutterMethodChannel(
      name: channelName,
      binaryMessenger: registrar.messenger()
    )
    channel = methodChannel
    methodChannel.setMethodCallHandler { [weak self] call, result in
      self?.handle(call, result: result)
    }
  }

  private func handle(_ call: FlutterMethodCall, result: @escaping FlutterResult) {
    let args = call.arguments as? [String: Any] ?? [:]
    switch call.method {
    case "checkPermissions":
      result(permissionSnapshot())
    case "requestPermission":
      requestPermission(args["permission"] as? String ?? "", result: result)
    case "startCameraPreview":
      startCameraPreview(lens: args["lens"] as? String ?? "back", result: result)
    case "stopCameraPreview":
      stopCameraPreview(result: result)
    case "disposeSession":
      disposeSession(result: result)
    case "switchCameraLens":
      switchCameraLens(requested: args["lens"] as? String, result: result)
    case "toggleCameraFlash":
      toggleCameraFlash(requested: args["flash"] as? String, result: result)
    case "capturePhoto":
      capturePhoto(result: result)
    case "listSavedPhotos":
      listSavedPhotos(result: result)
    case "deleteSavedPhoto":
      deleteSavedPhoto(path: args["filePath"] as? String ?? "", result: result)
    case "startBleScan":
      let timeoutMs = args["timeoutMs"] as? Int ?? 1600
      startBleScan(timeoutMs: max(250, min(timeoutMs, 30000)), result: result)
    case "connectBleDevice":
      connectBleDevice(id: args["deviceId"] as? String ?? "", result: result)
    case "readSensors":
      readSensors(result: result)
    case "authenticateBiometrics":
      authenticateBiometrics(
        reason: args["reason"] as? String ?? "Authenticate to continue",
        result: result
      )
    case "getCurrentLocation":
      getCurrentLocation(result: result)
    default:
      result(FlutterMethodNotImplemented)
    }
  }

  // MARK: - Permissions

  private func permissionSnapshot() -> [String: Any] {
    let cameraSupported = AVCaptureDevice.default(for: .video) != nil
    let cameraStatus = AVCaptureDevice.authorizationStatus(for: .video)
    let photosStatus = PHPhotoLibrary.authorizationStatus(for: .addOnly)
    let locationStatus = locationManager?.authorizationStatus ??
      CLLocationManager().authorizationStatus
    let biometricContext = LAContext()
    var biometricError: NSError?
    let biometricSupported = biometricContext.canEvaluatePolicy(
      .deviceOwnerAuthenticationWithBiometrics,
      error: &biometricError
    )
    return [
      "ok": true,
      "permissions": [
        "camera": permissionState(
          supported: cameraSupported,
          status: cameraStatusString(cameraStatus),
          granted: cameraSupported && cameraStatus == .authorized
        ),
        "photos": permissionState(
          supported: true,
          status: photoStatusString(photosStatus),
          granted: photosStatus == .authorized || photosStatus == .limited
        ),
        "bluetooth": permissionState(
          supported: CBCentralManager.stateIsSupported,
          status: bluetoothStatusString(),
          granted: CBCentralManager.authorization == .allowedAlways
        ),
        "sensors": permissionState(
          supported: CMMotionManager().isDeviceMotionAvailable ||
            CMAltimeter.isRelativeAltitudeAvailable(),
          status: "available",
          granted: CMMotionManager().isDeviceMotionAvailable ||
            CMAltimeter.isRelativeAltitudeAvailable()
        ),
        "biometrics": permissionState(
          supported: biometricSupported,
          status: biometricSupported ? "available" : "unavailable",
          granted: biometricSupported
        ),
        "location": permissionState(
          supported: CLLocationManager.locationServicesEnabled(),
          status: locationStatusString(locationStatus),
          granted: locationStatus == .authorizedAlways ||
            locationStatus == .authorizedWhenInUse
        ),
        "microphone": permissionState(
          supported: true,
          status: AVAudioSession.sharedInstance().recordPermission == .granted
            ? "granted"
            : AVAudioSession.sharedInstance().recordPermission == .denied
              ? "denied"
              : "notDetermined",
          granted: AVAudioSession.sharedInstance().recordPermission == .granted
        ),
        "network": permissionState(supported: true, status: "available", granted: true),
      ],
    ]
  }

  private func permissionState(supported: Bool, status: String, granted: Bool) -> [String: Any] {
    ["supported": supported, "status": status, "granted": granted]
  }

  private func requestPermission(_ permission: String, result: @escaping FlutterResult) {
    switch permission {
    case "camera":
      guard AVCaptureDevice.default(for: .video) != nil else {
        result(error(code: "hardware_unsupported", message: "camera is unavailable on this device"))
        return
      }
      AVCaptureDevice.requestAccess(for: .video) { granted in
        self.main {
          result([
            "ok": true,
            "permission": permission,
            "granted": granted,
            "status": granted ? "granted" : "denied",
            "realHardware": true,
          ])
        }
      }
    case "photos":
      PHPhotoLibrary.requestAuthorization(for: .addOnly) { status in
        self.main {
          let granted = status == .authorized || status == .limited
          result([
            "ok": true,
            "permission": permission,
            "granted": granted,
            "status": self.photoStatusString(status),
            "realHardware": true,
          ])
        }
      }
    case "microphone":
      AVAudioSession.sharedInstance().requestRecordPermission { granted in
        self.main {
          result([
            "ok": true,
            "permission": permission,
            "granted": granted,
            "status": granted ? "granted" : "denied",
            "realHardware": true,
          ])
        }
      }
    case "location":
      main {
        let manager = self.ensureLocationManager()
        switch manager.authorizationStatus {
        case .notDetermined:
          self.pendingPermissionResult = result
          manager.requestWhenInUseAuthorization()
        case .authorizedAlways, .authorizedWhenInUse:
          result([
            "ok": true,
            "permission": permission,
            "granted": true,
            "status": self.locationStatusString(manager.authorizationStatus),
            "realHardware": true,
          ])
        default:
          result(self.error(code: "hardware_permission_denied", message: "location permission is denied"))
        }
      }
    case "bluetooth":
      bleQueue.async {
        if self.central == nil {
          self.central = CBCentralManager(delegate: self, queue: self.bleQueue)
        }
        let state = self.central?.state ?? .unknown
        self.main {
          if state == .unsupported || state == .unauthorized {
            result(self.error(code: "hardware_permission_denied", message: "Bluetooth is unavailable or denied"))
          } else {
            result([
              "ok": true,
              "permission": permission,
              "granted": state == .poweredOn && CBCentralManager.authorization == .allowedAlways,
              "status": self.bluetoothStatusString(),
              "realHardware": true,
            ])
          }
        }
      }
    case "sensors":
      let supported = CMMotionManager().isDeviceMotionAvailable || CMAltimeter.isRelativeAltitudeAvailable()
      if supported {
        result(["ok": true, "permission": permission, "granted": true, "status": "available", "realHardware": true])
      } else {
        result(error(code: "hardware_unsupported", message: "motion and barometer sensors are unavailable"))
      }
    case "biometrics":
      let context = LAContext()
      var authError: NSError?
      let supported = context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &authError)
      if supported {
        result(["ok": true, "permission": permission, "granted": true, "status": "available", "realHardware": true])
      } else {
        result(error(code: "hardware_unsupported", message: authError?.localizedDescription ?? "biometric authentication is unavailable"))
      }
    case "network":
      result(["ok": true, "permission": permission, "granted": true, "status": "available", "realHardware": true])
    default:
      result(error(code: "invalid_argument", message: "unknown hardware permission"))
    }
  }

  // MARK: - Camera and photos

  private func startCameraPreview(lens: String, result: @escaping FlutterResult) {
    guard lens == "front" || lens == "back" else {
      result(error(code: "invalid_argument", message: "lens must be front or back"))
      return
    }
    guard AVCaptureDevice.authorizationStatus(for: .video) == .authorized else {
      result(error(code: "hardware_permission_denied", message: "camera permission is not granted"))
      return
    }
    guard let registry = textureRegistry else {
      result(error(code: "hardware_not_ready", message: "Flutter texture registry is not ready"))
      return
    }
    cameraQueue.async {
      do {
        let position: AVCaptureDevice.Position = lens == "front" ? .front : .back
        let device = try self.cameraDevice(for: position)
        let session = self.captureSession ?? AVCaptureSession()
        self.captureSession = session
        session.beginConfiguration()
        session.sessionPreset = .medium
        if let oldInput = self.cameraInput { session.removeInput(oldInput) }
        if let oldOutput = self.videoOutput { session.removeOutput(oldOutput) }
        if let oldPhotoOutput = self.photoOutput { session.removeOutput(oldPhotoOutput) }
        let input = try AVCaptureDeviceInput(device: device)
        guard session.canAddInput(input) else {
          throw PocketHardwareError(code: "hardware_unsupported", message: "camera input cannot be added")
        }
        session.addInput(input)
        let video = AVCaptureVideoDataOutput()
        video.alwaysDiscardsLateVideoFrames = true
        video.videoSettings = [
          kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
        ]
        guard session.canAddOutput(video) else {
          throw PocketHardwareError(code: "hardware_unsupported", message: "camera video output cannot be added")
        }
        session.addOutput(video)
        video.setSampleBufferDelegate(self, queue: self.cameraQueue)
        let photo = AVCapturePhotoOutput()
        guard session.canAddOutput(photo) else {
          throw PocketHardwareError(code: "hardware_unsupported", message: "camera photo output cannot be added")
        }
        session.addOutput(photo)
        session.commitConfiguration()
        self.cameraInput = input
        self.videoOutput = video
        self.photoOutput = photo
        self.cameraDevice = device
        self.cameraPosition = position
        if self.textureId == nil {
          let texture = PocketHardwareTexture()
          let id = registry.register(texture)
          self.cameraTexture = texture
          self.textureId = id
        }
        if !session.isRunning { session.startRunning() }
        let dimensions = CMVideoFormatDescriptionGetDimensions(device.activeFormat.formatDescription)
        let response: [String: Any] = [
          "ok": true,
          "previewActive": true,
          "textureId": self.textureId as Any,
          "width": Int(dimensions.width),
          "height": Int(dimensions.height),
          "lens": lens,
          "flash": self.flashName(),
          "realHardwareCamera": true,
        ]
        self.main { result(response) }
      } catch let hardwareError as PocketHardwareError {
        self.sessionCleanupAfterCameraFailure()
        self.main { result(self.error(code: hardwareError.code, message: hardwareError.message)) }
      } catch {
        self.sessionCleanupAfterCameraFailure()
        self.main { result(self.error(code: "hardware_camera_error", message: error.localizedDescription)) }
      }
    }
  }

  private func sessionCleanupAfterCameraFailure() {
    captureSession?.commitConfiguration()
    if let id = textureId, let registry = textureRegistry {
      registry.unregisterTexture(id)
    }
    textureId = nil
    cameraTexture = nil
    cameraInput = nil
    videoOutput = nil
    photoOutput = nil
    cameraDevice = nil
  }

  private func stopCameraPreview(result: @escaping FlutterResult) {
    cameraQueue.async {
      if let session = self.captureSession, session.isRunning { session.stopRunning() }
      if let session = self.captureSession {
        if let input = self.cameraInput { session.removeInput(input) }
        if let output = self.videoOutput { session.removeOutput(output) }
        if let output = self.photoOutput { session.removeOutput(output) }
      }
      self.cameraInput = nil
      self.videoOutput = nil
      self.photoOutput = nil
      self.cameraDevice = nil
      self.pendingPhotoResult = nil
      if let id = self.textureId, let registry = self.textureRegistry {
        registry.unregisterTexture(id)
      }
      self.textureId = nil
      self.cameraTexture = nil
      self.main {
        result(["ok": true, "previewActive": false, "realHardwareCamera": true])
      }
    }
  }

  /// Cancels every outstanding native operation before a guest package is
  /// replaced.  This is intentionally separate from camera stop: BLE,
  /// location, sensors, and an in-flight biometric prompt otherwise outlive
  /// the Dart plugin context and can deliver stale callbacks to a new guest.
  private func disposeSession(result: @escaping FlutterResult) {
    main {
      if let callback = self.pendingPhotoResult {
        self.pendingPhotoResult = nil
        callback(self.error(code: "plugin_revoked", message: "hardware session disposed"))
      }
      if let callback = self.pendingPermissionResult {
        self.pendingPermissionResult = nil
        callback(self.error(code: "plugin_revoked", message: "hardware session disposed"))
      }
      if let callback = self.pendingLocationResult {
        self.pendingLocationResult = nil
        self.locationTimeout?.cancel()
        self.locationTimeout = nil
        callback(self.error(code: "plugin_revoked", message: "hardware session disposed"))
      }
      self.activeBiometricContext?.invalidate()
      self.activeBiometricContext = nil
      self.sensorQueue.addOperation {
        self.motionManager.stopDeviceMotionUpdates()
        self.altimeter.stopRelativeAltitudeUpdates()
      }
      self.bleQueue.async {
        self.central?.stopScan()
        self.scanTimeout?.cancel()
        self.scanTimeout = nil
        if let callback = self.pendingScanResult {
          self.pendingScanResult = nil
          self.main { callback(self.error(code: "plugin_revoked", message: "hardware session disposed")) }
        }
        for (id, callback) in self.pendingConnections {
          if let peripheral = self.discovered[id] {
            self.central?.cancelPeripheralConnection(peripheral)
          }
          self.main { callback(self.error(code: "plugin_revoked", message: "hardware session disposed")) }
        }
        self.pendingConnections.removeAll()
        self.connectionTimeouts.values.forEach { $0.cancel() }
        self.connectionTimeouts.removeAll()
      }
      self.cameraQueue.async {
        if let session = self.captureSession, session.isRunning { session.stopRunning() }
        if let session = self.captureSession {
          if let input = self.cameraInput { session.removeInput(input) }
          if let output = self.videoOutput { session.removeOutput(output) }
          if let output = self.photoOutput { session.removeOutput(output) }
        }
        self.cameraInput = nil
        self.videoOutput = nil
        self.photoOutput = nil
        self.cameraDevice = nil
        if let id = self.textureId, let registry = self.textureRegistry {
          registry.unregisterTexture(id)
        }
        self.textureId = nil
        self.cameraTexture = nil
        self.main { result(["ok": true, "disposed": true]) }
      }
    }
  }

  private func switchCameraLens(requested: String?, result: @escaping FlutterResult) {
    let lens = requested ?? (cameraPosition == .back ? "front" : "back")
    startCameraPreview(lens: lens, result: result)
  }

  private func toggleCameraFlash(requested: String?, result: @escaping FlutterResult) {
    cameraQueue.async {
      guard let device = self.cameraDevice else {
        self.main { result(self.error(code: "hardware_not_ready", message: "camera preview is not running")) }
        return
      }
      guard device.hasFlash else {
        self.main { result(self.error(code: "hardware_unsupported", message: "selected camera has no flash")) }
        return
      }
      let next = requested ?? (self.flashMode == .off ? "on" : "off")
      let mode: AVCaptureDevice.FlashMode
      switch next {
      case "on": mode = .on
      case "auto": mode = .auto
      case "off": mode = .off
      default:
        self.main { result(self.error(code: "invalid_argument", message: "flash must be on, off or auto")) }
        return
      }
      do {
        try device.lockForConfiguration()
        device.unlockForConfiguration()
        self.flashMode = mode
        self.main { result(["ok": true, "flash": self.flashName(), "realHardwareCamera": true]) }
      } catch {
        self.main { result(self.error(code: "hardware_camera_error", message: error.localizedDescription)) }
      }
    }
  }

  private func capturePhoto(result: @escaping FlutterResult) {
    cameraQueue.async {
      guard let output = self.photoOutput, let device = self.cameraDevice else {
        self.main { result(self.error(code: "hardware_not_ready", message: "camera preview is not running")) }
        return
      }
      guard self.pendingPhotoResult == nil else {
        self.main { result(self.error(code: "hardware_busy", message: "a photo capture is already in progress")) }
        return
      }
      let settings = AVCapturePhotoSettings()
      if device.hasFlash { settings.flashMode = self.flashMode }
      self.pendingPhotoResult = result
      output.capturePhoto(with: settings, delegate: self)
    }
  }

  func photoOutput(_ output: AVCapturePhotoOutput, didFinishProcessingPhoto photo: AVCapturePhoto, error: Error?) {
    cameraQueue.async {
      guard let callback = self.pendingPhotoResult else { return }
      self.pendingPhotoResult = nil
      if let error = error {
        self.main { callback(self.error(code: "hardware_capture_error", message: error.localizedDescription)) }
        return
      }
      guard let data = photo.fileDataRepresentation() else {
        self.main { callback(self.error(code: "hardware_capture_error", message: "camera returned no photo data")) }
        return
      }
      do {
        let directory = try self.photoDirectory()
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let name = "POCKET_IMG_\(Int(Date().timeIntervalSince1970 * 1000)).jpg"
        let file = directory.appendingPathComponent(name)
        try data.write(to: file, options: .atomic)
        self.saveToPhotosIfAuthorized(file: file) { albumSaved, albumError in
          var response: [String: Any] = [
            "ok": true,
            "realHardwareCamera": true,
            "fileName": name,
            "filePath": file.path,
            "sizeBytes": data.count,
            "lens": self.cameraPosition == .front ? "front" : "back",
            "timestamp": ISO8601DateFormatter().string(from: Date()),
            "savedToAlbum": albumSaved,
          ]
          if let albumError = albumError { response["albumErrorCode"] = albumError }
          self.main { callback(response) }
        }
      } catch {
        self.main { callback(self.error(code: "hardware_storage_error", message: error.localizedDescription)) }
      }
    }
  }

  private func saveToPhotosIfAuthorized(
    file: URL,
    completion: @escaping (Bool, String?) -> Void
  ) {
    let status = PHPhotoLibrary.authorizationStatus(for: .addOnly)
    guard status == .authorized || status == .limited else {
      completion(false, "photos_permission_denied")
      return
    }
    PHPhotoLibrary.shared().performChanges({
      PHAssetChangeRequest.creationRequestForAssetFromImage(atFileURL: file)
    }) { saved, error in
      self.cameraQueue.async { completion(saved, error == nil ? nil : "photos_save_failed") }
    }
  }

  private func listSavedPhotos(result: @escaping FlutterResult) {
    cameraQueue.async {
      do {
        let photos = try self.listPhotos()
        self.main { result(["ok": true, "photos": photos, "realHardwareCamera": true]) }
      } catch {
        self.main { result(self.error(code: "hardware_storage_error", message: error.localizedDescription)) }
      }
    }
  }

  private func deleteSavedPhoto(path: String, result: @escaping FlutterResult) {
    cameraQueue.async {
      do {
        let directory = try self.photoDirectory().standardizedFileURL
        let file = URL(fileURLWithPath: path).standardizedFileURL
        guard file.path.hasPrefix(directory.path + "/") else {
          self.main { result(self.error(code: "invalid_argument", message: "photo path is outside the host photo directory")) }
          return
        }
        guard FileManager.default.fileExists(atPath: file.path) else {
          self.main { result(self.error(code: "hardware_not_found", message: "photo does not exist")) }
          return
        }
        try FileManager.default.removeItem(at: file)
        self.main { result(["ok": true, "deleted": true, "photos": (try? self.listPhotos()) ?? []]) }
      } catch {
        self.main { result(self.error(code: "hardware_storage_error", message: error.localizedDescription)) }
      }
    }
  }

  private func photoDirectory() throws -> URL {
    try FileManager.default.url(
      for: .documentDirectory,
      in: .userDomainMask,
      appropriateFor: nil,
      create: true
    ).appendingPathComponent("pocket_photos", isDirectory: true)
  }

  private func listPhotos() throws -> [[String: Any]] {
    let directory = try photoDirectory()
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    let files = try FileManager.default.contentsOfDirectory(
      at: directory,
      includingPropertiesForKeys: [.fileSizeKey, .contentModificationDateKey],
      options: [.skipsHiddenFiles]
    )
    return try files
      .filter { $0.pathExtension.lowercased() == "jpg" || $0.pathExtension.lowercased() == "jpeg" }
      .sorted { $0.lastPathComponent > $1.lastPathComponent }
      .map { file in
        let values = try file.resourceValues(forKeys: [.fileSizeKey, .contentModificationDateKey])
        return [
          "fileName": file.lastPathComponent,
          "filePath": file.path,
          "sizeBytes": values.fileSize ?? 0,
          "modifiedAt": ISO8601DateFormatter().string(from: values.contentModificationDate ?? Date()),
        ]
      }
  }

  func captureOutput(
    _ output: AVCaptureOutput,
    didOutput sampleBuffer: CMSampleBuffer,
    from connection: AVCaptureConnection
  ) {
    guard let buffer = CMSampleBufferGetImageBuffer(sampleBuffer), let texture = cameraTexture else { return }
    texture.update(buffer)
    if let id = textureId { textureRegistry?.textureFrameAvailable(id) }
  }

  private func cameraDevice(for position: AVCaptureDevice.Position) throws -> AVCaptureDevice {
    let discovery = AVCaptureDevice.DiscoverySession(
      deviceTypes: [.builtInWideAngleCamera, .builtInTrueDepthCamera, .builtInDualCamera],
      mediaType: .video,
      position: position
    )
    guard let device = discovery.devices.first else {
      throw PocketHardwareError(code: "hardware_unsupported", message: "requested camera lens is unavailable")
    }
    return device
  }

  private func flashName() -> String {
    switch flashMode { case .on: return "on"; case .auto: return "auto"; case .off: return "off"; @unknown default: return "off" }
  }

  // MARK: - Bluetooth

  private func ensureCentral() {
    if central == nil { central = CBCentralManager(delegate: self, queue: bleQueue) }
  }

  private func startBleScan(timeoutMs: Int, result: @escaping FlutterResult) {
    bleQueue.async {
      self.ensureCentral()
      guard let central = self.central else {
        self.main { result(self.error(code: "hardware_unsupported", message: "Bluetooth manager is unavailable")) }
        return
      }
      guard central.state == .poweredOn else {
        let code = central.state == .unauthorized ? "hardware_permission_denied" : "hardware_bluetooth_unavailable"
        self.main { result(self.error(code: code, message: "Bluetooth is not powered on")) }
        return
      }
      guard self.pendingScanResult == nil else {
        self.main { result(self.error(code: "hardware_busy", message: "Bluetooth scan is already running")) }
        return
      }
      self.discovered.removeAll()
      self.discoveredInfo.removeAll()
      self.pendingScanResult = result
      central.scanForPeripherals(withServices: nil, options: [CBCentralManagerScanOptionAllowDuplicatesKey: false])
      let timeout = DispatchWorkItem { self.finishBleScan() }
      self.scanTimeout = timeout
      self.bleQueue.asyncAfter(deadline: .now() + .milliseconds(timeoutMs), execute: timeout)
    }
  }

  private func finishBleScan() {
    central?.stopScan()
    guard let callback = pendingScanResult else { return }
    pendingScanResult = nil
    scanTimeout = nil
    let devices = discoveredInfo.values.sorted { "\($0["id"] ?? "")" < "\($1["id"] ?? "")" }
    main {
      callback(["ok": true, "realBle": true, "state": "poweredOn", "devices": devices])
    }
  }

  private func connectBleDevice(id: String, result: @escaping FlutterResult) {
    guard !id.isEmpty else {
      result(error(code: "invalid_argument", message: "deviceId must not be empty"))
      return
    }
    bleQueue.async {
      self.ensureCentral()
      guard self.central?.state == .poweredOn else {
        self.main { result(self.error(code: "hardware_bluetooth_unavailable", message: "Bluetooth is not powered on")) }
        return
      }
      guard let peripheral = self.discovered[id] else {
        self.main { result(self.error(code: "hardware_not_found", message: "device was not discovered by this host")) }
        return
      }
      guard self.pendingConnections[id] == nil else {
        self.main { result(self.error(code: "hardware_busy", message: "connection is already pending")) }
        return
      }
      self.pendingConnections[id] = result
      peripheral.delegate = self
      self.central?.connect(peripheral, options: nil)
      let timeout = DispatchWorkItem {
        self.finishConnection(id: id, value: self.error(code: "hardware_timeout", message: "Bluetooth connection timed out"))
      }
      self.connectionTimeouts[id] = timeout
      self.bleQueue.asyncAfter(deadline: .now() + 15, execute: timeout)
    }
  }

  private func finishConnection(id: String, value: [String: Any]) {
    connectionTimeouts[id]?.cancel()
    connectionTimeouts.removeValue(forKey: id)
    guard let callback = pendingConnections.removeValue(forKey: id) else { return }
    main { callback(value) }
  }

  func centralManagerDidUpdateState(_ central: CBCentralManager) {
    // A pending scan is completed with a structured error if Bluetooth turns
    // off while it is running; an empty result would falsely look healthy.
    guard central.state != .poweredOn, pendingScanResult != nil else { return }
    scanTimeout?.cancel()
    scanTimeout = nil
    let callback = pendingScanResult
    pendingScanResult = nil
    let code = central.state == .unauthorized ? "hardware_permission_denied" : "hardware_bluetooth_unavailable"
    main { callback?(self.error(code: code, message: "Bluetooth became unavailable")) }
  }

  func centralManager(
    _ central: CBCentralManager,
    didDiscover peripheral: CBPeripheral,
    advertisementData: [String: Any],
    rssi RSSI: NSNumber
  ) {
    let id = peripheral.identifier.uuidString
    discovered[id] = peripheral
    discoveredInfo[id] = [
      "id": id,
      "name": peripheral.name ?? advertisementData[CBAdvertisementDataLocalNameKey] as? String ?? "",
      "rssi": RSSI.intValue,
    ]
  }

  func centralManager(_ central: CBCentralManager, didConnect peripheral: CBPeripheral) {
    peripheral.discoverServices(nil)
  }

  func centralManager(_ central: CBCentralManager, didFailToConnect peripheral: CBPeripheral, error: Error?) {
    finishConnection(id: peripheral.identifier.uuidString, value: self.error(code: "hardware_bluetooth_connect", message: error?.localizedDescription ?? "Bluetooth connection failed"))
  }

  func peripheral(_ peripheral: CBPeripheral, didDiscoverServices error: Error?) {
    let id = peripheral.identifier.uuidString
    if let error = error {
      finishConnection(id: id, value: self.error(code: "hardware_bluetooth_services", message: error.localizedDescription))
      return
    }
    let services = peripheral.services?.map { $0.uuid.uuidString } ?? []
    finishConnection(id: id, value: [
      "ok": true,
      "realBle": true,
      "device": id,
      "state": "connected",
      "services": services,
    ])
  }

  // MARK: - Sensors, biometrics and location

  private func readSensors(result: @escaping FlutterResult) {
    sensorQueue.addOperation { [weak self] in
      guard let self = self else { return }
      let motionAvailable = self.motionManager.isDeviceMotionAvailable
      let altitudeAvailable = CMAltimeter.isRelativeAltitudeAvailable()
      guard motionAvailable || altitudeAvailable else {
        self.main { result(self.error(code: "hardware_unsupported", message: "motion and barometer sensors are unavailable")) }
        return
      }
      var motion: CMDeviceMotion?
      var pressure: Double?
      var relativeAltitude: Double?
      if motionAvailable {
        self.motionManager.deviceMotionUpdateInterval = 1.0 / 30.0
        self.motionManager.startDeviceMotionUpdates(to: self.sensorQueue) { value, _ in motion = value }
      }
      if altitudeAvailable {
        self.altimeter.startRelativeAltitudeUpdates(to: self.sensorQueue) { value, _ in
          if let value = value {
            pressure = value.pressure.doubleValue * 10.0
            relativeAltitude = value.relativeAltitude.doubleValue
          }
        }
      }
      // OperationQueue is required by Core Motion and has no delayed-submit
      // API.  Use a separate timer queue, then perform the sample read and
      // sensor shutdown on the motion queue.
      DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + .milliseconds(250)) {
        self.sensorQueue.addOperation {
          self.motionManager.stopDeviceMotionUpdates()
          self.altimeter.stopRelativeAltitudeUpdates()
          guard let motion = motion ?? self.motionManager.deviceMotion else {
            if let pressure = pressure {
              self.main { result(["ok": true, "realSensors": true, "pressureHpa": pressure, "relativeAltitudeM": relativeAltitude as Any]) }
            } else {
              self.main { result(self.error(code: "hardware_sensor_timeout", message: "sensor sample was unavailable")) }
            }
            return
          }
          var values: [String: Any] = [
            "ok": true,
            "realSensors": true,
            "accelX": motion.userAcceleration.x,
            "accelY": motion.userAcceleration.y,
            "accelZ": motion.userAcceleration.z,
            "gravityX": motion.gravity.x,
            "gravityY": motion.gravity.y,
            "gravityZ": motion.gravity.z,
            "gyroX": motion.rotationRate.x,
            "gyroY": motion.rotationRate.y,
            "gyroZ": motion.rotationRate.z,
            "pitch": motion.attitude.pitch,
            "roll": motion.attitude.roll,
            "yaw": motion.attitude.yaw,
          ]
          if let pressure = pressure { values["pressureHpa"] = pressure }
          if let altitude = relativeAltitude { values["relativeAltitudeM"] = altitude }
          self.main { result(values) }
        }
      }
    }
  }

  private func authenticateBiometrics(reason: String, result: @escaping FlutterResult) {
    guard !reason.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
      result(error(code: "invalid_argument", message: "biometric reason must not be empty"))
      return
    }
    let context = LAContext()
    var authError: NSError?
    guard context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &authError) else {
      result(error(code: "hardware_unsupported", message: authError?.localizedDescription ?? "biometrics are unavailable"))
      return
    }
    activeBiometricContext = context
    let type: String
    switch context.biometryType {
    case .faceID: type = "FaceID"
    case .touchID: type = "TouchID"
    default: type = "unknown"
    }
    context.evaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, localizedReason: reason) { success, error in
      self.main {
        self.activeBiometricContext = nil
        var response: [String: Any] = [
          "ok": true,
          "authenticated": success,
          "realBiometrics": true,
          "biometricType": type,
        ]
        if let error = error { response["errorCode"] = "hardware_biometric_failed"; response["error"] = error.localizedDescription }
        result(response)
      }
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
        result(self.error(code: "hardware_unsupported", message: "location services are disabled"))
        return
      }
      let manager = self.ensureLocationManager()
      switch manager.authorizationStatus {
      case .notDetermined:
        guard self.pendingLocationResult == nil else {
          result(self.error(code: "hardware_busy", message: "location request is already pending"))
          return
        }
        self.pendingLocationResult = result
        manager.requestWhenInUseAuthorization()
      case .authorizedAlways, .authorizedWhenInUse:
        guard self.pendingLocationResult == nil else {
          result(self.error(code: "hardware_busy", message: "location request is already pending"))
          return
        }
        self.pendingLocationResult = result
        manager.requestLocation()
        let timeout = DispatchWorkItem {
          guard let callback = self.pendingLocationResult else { return }
          self.pendingLocationResult = nil
          callback(self.error(code: "hardware_location_timeout", message: "no location fix was received"))
        }
        self.locationTimeout = timeout
        DispatchQueue.main.asyncAfter(deadline: .now() + 30, execute: timeout)
      default:
        result(self.error(code: "hardware_permission_denied", message: "location permission is denied"))
      }
    }
  }

  func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
    let status = manager.authorizationStatus
    if let callback = pendingPermissionResult {
      pendingPermissionResult = nil
      if status == .authorizedWhenInUse || status == .authorizedAlways {
        callback(["ok": true, "permission": "location", "granted": true, "status": locationStatusString(status), "realHardware": true])
      } else if status != .notDetermined {
        callback(error(code: "hardware_permission_denied", message: "location permission is denied"))
      }
    }
    if pendingLocationResult != nil, status == .authorizedWhenInUse || status == .authorizedAlways {
      ensureLocationManager().requestLocation()
      if locationTimeout == nil {
        let timeout = DispatchWorkItem { [weak self] in
          guard let self = self, let callback = self.pendingLocationResult else { return }
          self.pendingLocationResult = nil
          callback(self.error(code: "hardware_location_timeout", message: "no location fix was received"))
        }
        locationTimeout = timeout
        DispatchQueue.main.asyncAfter(deadline: .now() + 30, execute: timeout)
      }
    } else if let callback = pendingLocationResult, status != .notDetermined {
      pendingLocationResult = nil
      callback(error(code: "hardware_permission_denied", message: "location permission is denied"))
    }
  }

  func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
    guard let location = locations.last, let callback = pendingLocationResult else { return }
    pendingLocationResult = nil
    locationTimeout?.cancel()
    locationTimeout = nil
    callback([
      "ok": true,
      "realGps": true,
      "latitude": location.coordinate.latitude,
      "longitude": location.coordinate.longitude,
      "altitudeM": location.altitude,
      "horizontalAccuracyM": location.horizontalAccuracy,
      "timestamp": ISO8601DateFormatter().string(from: location.timestamp),
    ])
  }

  func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
    guard let callback = pendingLocationResult else { return }
    pendingLocationResult = nil
    locationTimeout?.cancel()
    locationTimeout = nil
    callback(self.error(code: "hardware_location_error", message: error.localizedDescription))
  }

  // MARK: - Helpers

  private func main(_ block: @escaping () -> Void) {
    if Thread.isMainThread { block() } else { DispatchQueue.main.async(execute: block) }
  }

  private func error(code: String, message: String) -> [String: Any] {
    ["ok": false, "errorCode": code, "error": message]
  }

  private func cameraStatusString(_ status: AVAuthorizationStatus) -> String {
    switch status { case .authorized: return "granted"; case .denied: return "denied"; case .restricted: return "restricted"; case .notDetermined: return "notDetermined"; @unknown default: return "unknown" }
  }

  private func photoStatusString(_ status: PHAuthorizationStatus) -> String {
    switch status { case .authorized: return "granted"; case .limited: return "limited"; case .denied: return "denied"; case .restricted: return "restricted"; case .notDetermined: return "notDetermined"; @unknown default: return "unknown" }
  }

  private func locationStatusString(_ status: CLAuthorizationStatus) -> String {
    switch status { case .authorizedAlways: return "authorizedAlways"; case .authorizedWhenInUse: return "authorizedWhenInUse"; case .denied: return "denied"; case .restricted: return "restricted"; case .notDetermined: return "notDetermined"; @unknown default: return "unknown" }
  }

  private func bluetoothStatusString() -> String {
    switch central?.state ?? .unknown {
    case .poweredOn: return "poweredOn"
    case .poweredOff: return "poweredOff"
    case .unauthorized: return "unauthorized"
    case .unsupported: return "unsupported"
    case .resetting: return "resetting"
    case .unknown: return "unknown"
    @unknown default: return "unknown"
    }
  }
}

private final class PocketHardwareTexture: NSObject, FlutterTexture {
  private let lock = NSLock()
  private var latestBuffer: CVPixelBuffer?

  func update(_ buffer: CVPixelBuffer) {
    lock.lock()
    latestBuffer = buffer
    lock.unlock()
  }

  func copyPixelBuffer() -> Unmanaged<CVPixelBuffer>? {
    lock.lock()
    let buffer = latestBuffer
    lock.unlock()
    guard let buffer = buffer else { return nil }
    return Unmanaged.passRetained(buffer)
  }
}

private struct PocketHardwareError: Error {
  let code: String
  let message: String
}

private extension CBCentralManager {
  static var stateIsSupported: Bool {
    // CoreBluetooth has no separate hardware probe.  An unsupported state is
    // reported by the manager once it is initialized; expose a conservative
    // capability status before that initialization.
    true
  }
}
