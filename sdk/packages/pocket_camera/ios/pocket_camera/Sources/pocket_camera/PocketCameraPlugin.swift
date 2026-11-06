import AVFoundation
import Flutter
import Foundation
import Photos

/// Independent iOS transport for the camera capability group.
public final class PocketCameraPlugin: NSObject, FlutterPlugin {
  public static func register(with registrar: FlutterPluginRegistrar) {
    PocketCameraManager.shared.attach(registrar: registrar)
  }
}

private final class PocketCameraManager: NSObject,
  AVCaptureVideoDataOutputSampleBufferDelegate,
  AVCapturePhotoCaptureDelegate
{
  static let shared = PocketCameraManager()

  private let channelName = "com.pocketnexus.host/hardware/camera"
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
  private var cameraTexture: PocketCameraTexture?
  private var textureId: Int64?
  private var pendingPhotoResult: FlutterResult?
  private var pendingPhotoCaptureID: Int64?
  private var pendingPhotoGeneration: UInt64?
  private var photoCaptureGeneration: UInt64 = 0

  private override init() { super.init() }

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
    case "startCameraPreview":
      startCameraPreview(lens: args["lens"] as? String ?? "back", result: result)
    case "stopCameraPreview":
      stopCameraPreview(result: result)
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
    case "disposeSession":
      disposeSession(result: result)
    default:
      result(error(code: "hardware_unsupported", message: "unknown camera method: \(call.method)"))
    }
  }

  private func startCameraPreview(lens: String, result: @escaping FlutterResult) {
    guard lens == "front" || lens == "back" else {
      result(error(code: "invalid_argument", message: "lens must be front or back"))
      return
    }
    let authorization = AVCaptureDevice.authorizationStatus(for: .video)
    guard authorization == .authorized else {
      let message = authorization == .notDetermined
        ? "camera permission is not granted; request it through the permissions service"
        : "camera permission is denied"
      result(error(code: "hardware_permission_denied", message: message))
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
          throw PocketCameraError(code: "hardware_unsupported", message: "camera input cannot be added")
        }
        session.addInput(input)
        let video = AVCaptureVideoDataOutput()
        video.alwaysDiscardsLateVideoFrames = true
        video.videoSettings = [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA]
        guard session.canAddOutput(video) else {
          throw PocketCameraError(code: "hardware_unsupported", message: "camera video output cannot be added")
        }
        session.addOutput(video)
        video.setSampleBufferDelegate(self, queue: self.cameraQueue)
        let photo = AVCapturePhotoOutput()
        guard session.canAddOutput(photo) else {
          throw PocketCameraError(code: "hardware_unsupported", message: "camera photo output cannot be added")
        }
        session.addOutput(photo)
        session.commitConfiguration()
        self.cameraInput = input
        self.videoOutput = video
        self.photoOutput = photo
        self.cameraDevice = device
        self.cameraPosition = position
        if self.textureId == nil {
          let texture = PocketCameraTexture()
          let id = registry.register(texture)
          self.cameraTexture = texture
          self.textureId = id
        }
        if !session.isRunning { session.startRunning() }
        let dimensions = CMVideoFormatDescriptionGetDimensions(device.activeFormat.formatDescription)
        self.main {
          result([
            "ok": true, "previewActive": true, "textureId": self.textureId as Any,
            "width": Int(dimensions.width), "height": Int(dimensions.height),
            "lens": lens, "flash": self.flashName(), "realHardwareCamera": true,
          ])
        }
      } catch let failure as PocketCameraError {
        self.sessionCleanupAfterCameraFailure()
        self.main { result(self.error(code: failure.code, message: failure.message)) }
      } catch {
        self.sessionCleanupAfterCameraFailure()
        self.main { result(self.error(code: "hardware_camera_error", message: error.localizedDescription)) }
      }
    }
  }

  private func sessionCleanupAfterCameraFailure() {
    captureSession?.commitConfiguration()
    if let id = textureId, let registry = textureRegistry { registry.unregisterTexture(id) }
    textureId = nil; cameraTexture = nil; cameraInput = nil; videoOutput = nil
    photoOutput = nil; cameraDevice = nil
  }

  private func stopCameraPreview(result: @escaping FlutterResult) {
    cameraQueue.async {
      self.stopCameraResources()
      self.main { result(["ok": true, "previewActive": false, "realHardwareCamera": true]) }
    }
  }

  private func disposeSession(result: @escaping FlutterResult) {
    cameraQueue.async {
      self.photoCaptureGeneration &+= 1
      if let callback = self.pendingPhotoResult {
        self.pendingPhotoResult = nil
        self.pendingPhotoCaptureID = nil
        self.pendingPhotoGeneration = nil
        self.main { callback(self.error(code: "plugin_revoked", message: "camera session disposed")) }
      }
      self.stopCameraResources()
      self.main { result(["ok": true, "disposed": true]) }
    }
  }

  private func stopCameraResources() {
    if let session = captureSession, session.isRunning { session.stopRunning() }
    if let session = captureSession {
      if let input = cameraInput { session.removeInput(input) }
      if let output = videoOutput { session.removeOutput(output) }
      if let output = photoOutput { session.removeOutput(output) }
    }
    cameraInput = nil; videoOutput = nil; photoOutput = nil; cameraDevice = nil
    photoCaptureGeneration &+= 1
    if let pending = pendingPhotoResult {
      pendingPhotoResult = nil; pendingPhotoCaptureID = nil; pendingPhotoGeneration = nil
      main { pending(FlutterError(code: "cancelled", message: "Camera preview stopped before photo capture completed", details: nil)) }
    }
    if let id = textureId, let registry = textureRegistry { registry.unregisterTexture(id) }
    textureId = nil; cameraTexture = nil
  }

  private func switchCameraLens(requested: String?, result: @escaping FlutterResult) {
    startCameraPreview(lens: requested ?? (cameraPosition == .back ? "front" : "back"), result: result)
  }

  private func toggleCameraFlash(requested: String?, result: @escaping FlutterResult) {
    guard AVCaptureDevice.authorizationStatus(for: .video) == .authorized else {
      result(error(code: "hardware_permission_denied", message: "camera permission is not granted"))
      return
    }
    cameraQueue.async {
      guard let device = self.cameraDevice else {
        self.main { result(self.error(code: "hardware_not_ready", message: "camera preview is not running")) }; return
      }
      guard device.hasFlash else {
        self.main { result(self.error(code: "hardware_unsupported", message: "selected camera has no flash")) }; return
      }
      let next = requested ?? (self.flashMode == .off ? "on" : "off")
      let mode: AVCaptureDevice.FlashMode
      switch next { case "on": mode = .on; case "auto": mode = .auto; case "off": mode = .off
      default: self.main { result(self.error(code: "invalid_argument", message: "flash must be on, off or auto")) }; return }
      do {
        try device.lockForConfiguration(); device.unlockForConfiguration(); self.flashMode = mode
        self.main { result(["ok": true, "flash": self.flashName(), "realHardwareCamera": true]) }
      } catch { self.main { result(self.error(code: "hardware_camera_error", message: error.localizedDescription)) } }
    }
  }

  private func capturePhoto(result: @escaping FlutterResult) {
    guard AVCaptureDevice.authorizationStatus(for: .video) == .authorized else {
      result(error(code: "hardware_permission_denied", message: "camera permission is not granted")); return
    }
    cameraQueue.async {
      guard let output = self.photoOutput, let device = self.cameraDevice else {
        self.main { result(self.error(code: "hardware_not_ready", message: "camera preview is not running")) }; return
      }
      guard self.pendingPhotoResult == nil else {
        self.main { result(self.error(code: "hardware_busy", message: "a photo capture is already in progress")) }; return
      }
      self.photoCaptureGeneration &+= 1
      let generation = self.photoCaptureGeneration
      let settings = AVCapturePhotoSettings()
      if device.hasFlash { settings.flashMode = self.flashMode }
      self.pendingPhotoCaptureID = settings.uniqueID; self.pendingPhotoGeneration = generation
      self.pendingPhotoResult = result
      output.capturePhoto(with: settings, delegate: self)
    }
  }

  func photoOutput(_ output: AVCapturePhotoOutput, didFinishProcessingPhoto photo: AVCapturePhoto, error: Error?) {
    cameraQueue.async {
      guard let captureID = self.pendingPhotoCaptureID, let generation = self.pendingPhotoGeneration,
            photo.resolvedSettings.uniqueID == captureID, self.photoCaptureGeneration == generation,
            self.pendingPhotoResult != nil else { return }
      if let failure = error {
        if let callback = self.pendingPhotoResult {
          self.pendingPhotoResult = nil; self.pendingPhotoCaptureID = nil; self.pendingPhotoGeneration = nil
          self.main { callback(self.error(code: "hardware_capture_error", message: failure.localizedDescription)) }
        }
        return
      }
      guard let data = photo.fileDataRepresentation() else {
        if let callback = self.pendingPhotoResult {
          self.pendingPhotoResult = nil; self.pendingPhotoCaptureID = nil; self.pendingPhotoGeneration = nil
          self.main { callback(self.error(code: "hardware_capture_error", message: "camera returned no photo data")) }
        }
        return
      }
      do {
        let directory = try self.photoDirectory()
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let name = "POCKET_IMG_\(Int(Date().timeIntervalSince1970 * 1000)).jpg"
        let file = directory.appendingPathComponent(name)
        try data.write(to: file, options: .atomic)
        self.saveToPhotosIfAuthorized(file: file) { albumSaved, albumError in
          self.cameraQueue.async {
            guard self.photoCaptureGeneration == generation, self.pendingPhotoCaptureID == captureID,
                  let callback = self.pendingPhotoResult else { return }
            self.pendingPhotoResult = nil; self.pendingPhotoCaptureID = nil; self.pendingPhotoGeneration = nil
            var response: [String: Any] = [
              "ok": true, "realHardwareCamera": true, "fileName": name, "filePath": file.path,
              "sizeBytes": data.count, "lens": self.cameraPosition == .front ? "front" : "back",
              "timestamp": ISO8601DateFormatter().string(from: Date()), "savedToAlbum": albumSaved,
            ]
            if let albumError = albumError { response["albumErrorCode"] = albumError }
            self.main { callback(response) }
          }
        }
      } catch {
        guard self.photoCaptureGeneration == generation, self.pendingPhotoCaptureID == captureID,
              let callback = self.pendingPhotoResult else { return }
        self.pendingPhotoResult = nil; self.pendingPhotoCaptureID = nil; self.pendingPhotoGeneration = nil
        self.main { callback(self.error(code: "hardware_storage_error", message: error.localizedDescription)) }
      }
    }
  }

  private func saveToPhotosIfAuthorized(file: URL, completion: @escaping (Bool, String?) -> Void) {
    let status = PHPhotoLibrary.authorizationStatus(for: .addOnly)
    guard status == .authorized || status == .limited else { completion(false, "photos_permission_denied"); return }
    PHPhotoLibrary.shared().performChanges({
      PHAssetChangeRequest.creationRequestForAssetFromImage(atFileURL: file)
    }) { saved, failure in
      self.cameraQueue.async { completion(saved, failure == nil ? nil : "photos_save_failed") }
    }
  }

  private func listSavedPhotos(result: @escaping FlutterResult) {
    cameraQueue.async {
      self.main { result(["ok": true, "photos": (try? self.listPhotos()) ?? [], "realHardwareCamera": true]) }
    }
  }

  private func deleteSavedPhoto(path: String, result: @escaping FlutterResult) {
    cameraQueue.async {
      do {
        let directory = try self.photoDirectory().standardizedFileURL
        let file = URL(fileURLWithPath: path).standardizedFileURL
        guard file.path.hasPrefix(directory.path + "/") else {
          self.main { result(self.error(code: "invalid_argument", message: "photo path is outside the host photo directory")) }; return
        }
        guard FileManager.default.fileExists(atPath: file.path) else {
          self.main { result(self.error(code: "hardware_not_found", message: "photo does not exist")) }; return
        }
        try FileManager.default.removeItem(at: file)
        self.main { result(["ok": true, "deleted": true, "photos": (try? self.listPhotos()) ?? []]) }
      } catch { self.main { result(self.error(code: "hardware_storage_error", message: error.localizedDescription)) } }
    }
  }

  private func photoDirectory() throws -> URL {
    try FileManager.default.url(for: .documentDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
      .appendingPathComponent("pocket_photos", isDirectory: true)
  }

  private func listPhotos() throws -> [[String: Any]] {
    let directory = try photoDirectory()
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    let files = try FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: [.fileSizeKey, .contentModificationDateKey], options: [.skipsHiddenFiles])
    return try files.filter { ["jpg", "jpeg"].contains($0.pathExtension.lowercased()) }
      .sorted { $0.lastPathComponent > $1.lastPathComponent }.map { file in
        let values = try file.resourceValues(forKeys: [.fileSizeKey, .contentModificationDateKey])
        return ["fileName": file.lastPathComponent, "filePath": file.path, "sizeBytes": values.fileSize ?? 0,
                "modifiedAt": ISO8601DateFormatter().string(from: values.contentModificationDate ?? Date())]
      }
  }

  func captureOutput(_ output: AVCaptureOutput, didOutput sampleBuffer: CMSampleBuffer, from connection: AVCaptureConnection) {
    guard let buffer = CMSampleBufferGetImageBuffer(sampleBuffer), let texture = cameraTexture else { return }
    texture.update(buffer)
    if let id = textureId { textureRegistry?.textureFrameAvailable(id) }
  }

  private func cameraDevice(for position: AVCaptureDevice.Position) throws -> AVCaptureDevice {
    let discovery = AVCaptureDevice.DiscoverySession(deviceTypes: [.builtInWideAngleCamera, .builtInTrueDepthCamera, .builtInDualCamera], mediaType: .video, position: position)
    guard let device = discovery.devices.first else { throw PocketCameraError(code: "hardware_unsupported", message: "requested camera lens is unavailable") }
    return device
  }

  private func flashName() -> String {
    switch flashMode { case .on: return "on"; case .auto: return "auto"; case .off: return "off"; @unknown default: return "off" }
  }

  private func main(_ block: @escaping () -> Void) {
    if Thread.isMainThread { block() } else { DispatchQueue.main.async(execute: block) }
  }

  private func error(code: String, message: String) -> [String: Any] { ["ok": false, "errorCode": code, "error": message] }
}

private final class PocketCameraTexture: NSObject, FlutterTexture {
  private let lock = NSLock()
  private var latestBuffer: CVPixelBuffer?
  func update(_ buffer: CVPixelBuffer) { lock.lock(); latestBuffer = buffer; lock.unlock() }
  func copyPixelBuffer() -> Unmanaged<CVPixelBuffer>? {
    lock.lock(); let buffer = latestBuffer; lock.unlock()
    guard let buffer = buffer else { return nil }
    return Unmanaged.passRetained(buffer)
  }
}

private struct PocketCameraError: Error { let code: String; let message: String }
