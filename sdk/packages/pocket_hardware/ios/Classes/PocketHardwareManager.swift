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
  CLLocationManagerDelegate,
  FlutterStreamHandler
{
  static let shared = PocketHardwareManager()

  private let channelName = "com.pocketnexus.host/hardware"
  private let eventsChannelName = "com.pocketnexus.host/hardware/events"
  private var channel: FlutterMethodChannel?
  private var eventsChannel: FlutterEventChannel?
  private var hardwareEventSink: FlutterEventSink?
  private var bufferedHardwareEvents: [[String: Any]] = []
  private let maxBufferedHardwareEvents = 64
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
  // Both values identify the capture whose result is currently retained.  A
  // late AVCapturePhoto callback from an older capture must never complete a
  // newer request that has reused the single pending-result slot.
  private var pendingPhotoCaptureID: Int64?
  private var pendingPhotoGeneration: UInt64?
  private var photoCaptureGeneration: UInt64 = 0
  private var activeBiometricContext: LAContext?

  private let bleQueue = DispatchQueue(
    label: "com.pocketnexus.host.hardware.bluetooth",
    qos: .userInitiated
  )
  private var central: CBCentralManager?
  private var discovered: [String: CBPeripheral] = [:]
  private var discoveredInfo: [String: [String: Any]] = [:]
  private var pendingScanResult: FlutterResult?
  private var pendingScanSessionId: String?
  private var scanGeneration: UInt64 = 0
  private var scanTimeout: DispatchWorkItem?
  private var pendingConnections: [String: FlutterResult] = [:]
  private var pendingConnectionSessions: [String: String] = [:]
  private var pendingConnectionPeripherals: [String: CBPeripheral] = [:]
  private var connectionTimeouts: [String: DispatchWorkItem] = [:]
  private var connectedSessionByDevice: [String: String] = [:]
  private var pendingGattOperations: [String: PocketGattOperation] = [:]
  private var queuedGattOperations: [String: [PocketGattOperation]] = [:]
  private var activeGattOperationByDevice: [String: String] = [:]
  private var nextGattOperationId: UInt64 = 0
  // All values in this dictionary are owned by bleQueue. A notification
  // subscription is a real CCCD GATT operation, not a direct
  // setNotifyValue call, so it is ordered with reads and writes.
  private var notificationStates: [String: PocketNotificationState] = [:]

  private let streamQueue = DispatchQueue(
    label: "com.pocketnexus.host.hardware.streams",
    qos: .userInitiated
  )
  private var hardwareStreams: [String: PocketHardwareStreamState] = [:]
  private var sensorStreamProducerRunning = false
  private var latestStreamMotion: CMDeviceMotion?
  private var latestStreamPressureHpa: Double?
  private var latestStreamRelativeAltitudeM: Double?

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
  private var sensorGeneration: UInt64 = 0
  private var sensorOwnerToken: String?
  private var sensorSessionId: String?
  private var sensorOperationId: Int?
  private var pendingSensorResult: FlutterResult?
  private var sensorTimeout: DispatchWorkItem?
  private var motionAccessVerified = false

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
    let eventChannel = FlutterEventChannel(
      name: eventsChannelName,
      binaryMessenger: registrar.messenger()
    )
    eventsChannel = eventChannel
    eventChannel.setStreamHandler(self)
  }

  private func handle(_ call: FlutterMethodCall, result: @escaping FlutterResult) {
    let args = call.arguments as? [String: Any] ?? [:]
    switch call.method {
    case "checkPermissions":
      result(permissionSnapshot())
    case "requestPermission":
      requestPermission(
        args["permission"] as? String ?? "",
        ownerToken: args["ownerToken"] as? String,
        sessionId: args["sessionId"] as? String,
        operationId: args["operationId"] as? Int,
        timeoutMs: args["timeoutMs"] as? Int,
        result: result
      )
    case "startCameraPreview":
      startCameraPreview(lens: args["lens"] as? String ?? "back", result: result)
    case "stopCameraPreview":
      stopCameraPreview(result: result)
    case "disposeSession":
      disposeSession(
        sessionId: args["sessionId"] as? String,
        sensorOwnerToken: args["sensorOwnerToken"] as? String,
        result: result
      )
    case "cancelSensorOperation":
      cancelSensorOperation(
        ownerToken: args["ownerToken"] as? String,
        operationId: args["operationId"] as? Int,
        result: result
      )
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
      startBleScan(
        timeoutMs: max(250, min(timeoutMs, 30000)),
        sessionId: args["sessionId"] as? String,
        result: result
      )
    case "connectBleDevice":
      connectBleDevice(
        id: args["deviceId"] as? String ?? "",
        sessionId: args["sessionId"] as? String,
        result: result
      )
    case "readBleCharacteristic":
      readBleCharacteristic(
        deviceId: args["deviceId"] as? String ?? "",
        serviceUuid: args["serviceUuid"] as? String ?? "",
        characteristicUuid: args["characteristicUuid"] as? String ?? "",
        sessionId: args["sessionId"] as? String,
        result: result
      )
    case "writeBleCharacteristic":
      writeBleCharacteristic(
        deviceId: args["deviceId"] as? String ?? "",
        serviceUuid: args["serviceUuid"] as? String ?? "",
        characteristicUuid: args["characteristicUuid"] as? String ?? "",
        value: args["value"] as? [Any] ?? [],
        withResponse: args["withResponse"] as? Bool ?? true,
        sessionId: args["sessionId"] as? String,
        result: result
      )
    case "startHardwareStream":
      startHardwareStream(
        kind: args["kind"] as? String ?? "",
        streamId: args["streamId"] as? String ?? "",
        sessionId: args["sessionId"] as? String,
        args: args,
        result: result
      )
    case "stopHardwareStream":
      stopHardwareStream(
        streamId: args["streamId"] as? String ?? "",
        sessionId: args["sessionId"] as? String,
        result: result
      )
    case "readSensors":
      readSensors(
        ownerToken: args["ownerToken"] as? String,
        sessionId: args["sessionId"] as? String,
        operationId: args["operationId"] as? Int,
        timeoutMs: args["timeoutMs"] as? Int,
        result: result
      )
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

  // MARK: - Shared hardware event channel and continuous streams

  func onListen(withArguments arguments: Any?, eventSink events: @escaping FlutterEventSink) -> FlutterError? {
    main {
      self.hardwareEventSink = events
      let buffered = self.bufferedHardwareEvents
      self.bufferedHardwareEvents.removeAll(keepingCapacity: true)
      for packet in buffered { events(packet) }
    }
    return nil
  }

  func onCancel(withArguments arguments: Any?) -> FlutterError? {
    main { self.hardwareEventSink = nil }
    return nil
  }

  private func emitHardwareEvent(streamId: String, data: Any) {
    let packet: [String: Any] = ["streamId": streamId, "data": data]
    main {
      guard let sink = self.hardwareEventSink else {
        if self.bufferedHardwareEvents.count >= self.maxBufferedHardwareEvents {
          self.bufferedHardwareEvents.removeFirst()
        }
        self.bufferedHardwareEvents.append(packet)
        return
      }
      sink(packet)
    }
  }

  private func emitHardwareError(streamId: String, code: String, message: String) {
    let packet: [String: Any] = [
      "streamId": streamId,
      "error": ["code": code, "message": message],
    ]
    main {
      self.bufferedHardwareEvents.removeAll { "\($0["streamId"] ?? "")" == streamId }
      guard let sink = self.hardwareEventSink else {
        if self.bufferedHardwareEvents.count >= self.maxBufferedHardwareEvents {
          self.bufferedHardwareEvents.removeFirst()
        }
        self.bufferedHardwareEvents.append(packet)
        return
      }
      sink(packet)
    }
  }

  private func emitHardwareDone(streamId: String) {
    let packet: [String: Any] = ["streamId": streamId, "done": true]
    main {
      guard let sink = self.hardwareEventSink else {
        if self.bufferedHardwareEvents.count >= self.maxBufferedHardwareEvents {
          self.bufferedHardwareEvents.removeFirst()
        }
        self.bufferedHardwareEvents.append(packet)
        return
      }
      sink(packet)
    }
  }

  private func clearBufferedHardwareEvents(streamId: String) {
    main {
      self.bufferedHardwareEvents.removeAll { "\($0["streamId"] ?? "")" == streamId }
    }
  }

  private func startHardwareStream(
    kind: String,
    streamId: String,
    sessionId: String?,
    args: [String: Any],
    result: @escaping FlutterResult
  ) {
    guard !streamId.isEmpty, let sessionId = sessionId, !sessionId.isEmpty else {
      result(error(code: "invalid_argument", message: "streamId and sessionId are required"))
      return
    }
    guard kind == "sensors" || kind == "ble.notifications" else {
      result(error(code: "invalid_argument", message: "unknown hardware stream kind"))
      return
    }
    if kind == "ble.notifications" {
      guard let deviceId = args["deviceId"] as? String, !deviceId.isEmpty,
            let serviceUuid = args["serviceUuid"] as? String, !serviceUuid.isEmpty,
            let characteristicUuid = args["characteristicUuid"] as? String, !characteristicUuid.isEmpty else {
        result(error(code: "invalid_argument", message: "deviceId, serviceUuid, and characteristicUuid are required"))
        return
      }
    }
    streamQueue.async {
      guard self.hardwareStreams[streamId] == nil else {
        self.main { result(self.error(code: "hardware_stream_exists", message: "hardware stream id is already active")) }
        return
      }
      if kind == "sensors" {
        let rawHz = (args["samplingHz"] as? NSNumber)?.doubleValue ?? 10.0
        guard rawHz.isFinite, rawHz >= 1.0, rawHz <= 60.0 else {
          self.main { result(self.error(code: "invalid_argument", message: "samplingHz must be between 1 and 60")) }
          return
        }
        let motionAvailable = self.motionManager.isDeviceMotionAvailable
        let altitudeAvailable = CMAltimeter.isRelativeAltitudeAvailable()
        guard motionAvailable || altitudeAvailable else {
          self.main { result(self.error(code: "hardware_unsupported", message: "motion and barometer sensors are unavailable")) }
          return
        }
        if altitudeAvailable {
          let status = CMAltimeter.authorizationStatus()
          if status == .denied || status == .restricted {
            self.main { result(self.error(code: "hardware_permission_denied", message: "motion and fitness permission is denied")) }
            return
          }
        }
        self.hardwareStreams[streamId] = PocketHardwareStreamState(
          streamId: streamId,
          kind: kind,
          sessionId: sessionId,
          samplingHz: rawHz,
          ready: true
        )
        self.startSensorStreamProducerIfNeeded()
        self.main {
          result(["ok": true, "streamId": streamId, "kind": kind, "realHardware": true])
        }
        return
      }
      let deviceId = args["deviceId"] as? String ?? ""
      let serviceUuid = args["serviceUuid"] as? String ?? ""
      let characteristicUuid = args["characteristicUuid"] as? String ?? ""
      // Install the pending state before crossing to bleQueue. A concurrent
      // stop/dispose can now observe and cancel this start instead of
      // resurrecting a producer after the caller has gone away.
      self.hardwareStreams[streamId] = PocketHardwareStreamState(
        streamId: streamId,
        kind: kind,
        sessionId: sessionId,
        deviceId: deviceId,
        serviceUuid: serviceUuid,
        characteristicUuid: characteristicUuid,
        startResult: result
      )
      self.bleQueue.async {
        self.prepareNotificationStream(
          streamId: streamId,
          sessionId: sessionId,
          deviceId: deviceId,
          serviceUuid: serviceUuid,
          characteristicUuid: characteristicUuid
        )
      }
    }
  }

  private func stopHardwareStream(
    streamId: String,
    sessionId: String?,
    result: @escaping FlutterResult
  ) {
    guard !streamId.isEmpty, let sessionId = sessionId, !sessionId.isEmpty else {
      result(error(code: "invalid_argument", message: "streamId and sessionId are required"))
      return
    }
    streamQueue.async {
      guard let state = self.hardwareStreams[streamId] else {
        self.main { result(["ok": true, "streamId": streamId, "stopped": false]) }
        return
      }
      guard state.sessionId == sessionId else {
        self.main { result(self.error(code: "hardware_owner_mismatch", message: "stream belongs to another hardware session")) }
        return
      }
      self.hardwareStreams.removeValue(forKey: streamId)
      if state.kind == "sensors" {
        self.stopSensorStreamProducerIfUnused()
      } else if let deviceId = state.deviceId,
                let serviceUuid = state.serviceUuid,
                let characteristicUuid = state.characteristicUuid {
        self.bleQueue.async {
          self.cancelNotificationStream(
            streamId: streamId,
            deviceId: deviceId,
            serviceUuid: serviceUuid,
            characteristicUuid: characteristicUuid
          )
        }
      }
      let pendingStart = state.startResult
      state.startResult = nil
      self.clearBufferedHardwareEvents(streamId: streamId)
      self.emitHardwareDone(streamId: streamId)
      if let pendingStart = pendingStart {
        self.main {
          pendingStart(self.error(code: "hardware_cancelled", message: "hardware stream was stopped before it started"))
        }
      }
      self.main { result(["ok": true, "streamId": streamId, "stopped": true]) }
    }
  }

  private func streamIsActive(streamId: String, sessionId: String) -> Bool {
    streamQueue.sync {
      guard let state = hardwareStreams[streamId] else { return false }
      return state.sessionId == sessionId
    }
  }

  private func bindNotificationCharacteristic(
    streamId: String,
    sessionId: String,
    characteristic: CBCharacteristic
  ) -> Bool {
    streamQueue.sync {
      guard let state = hardwareStreams[streamId], state.sessionId == sessionId else {
        return false
      }
      state.characteristic = characteristic
      return true
    }
  }

  private func prepareNotificationStream(
    streamId: String,
    sessionId: String,
    deviceId: String,
    serviceUuid: String,
    characteristicUuid: String
  ) {
    guard streamIsActive(streamId: streamId, sessionId: sessionId) else { return }
    guard let peripheral = discovered[deviceId] else {
      failHardwareStream(
        streamId: streamId,
        sessionId: sessionId,
        code: "hardware_not_found",
        message: "device was not discovered by this host"
      )
      return
    }
    guard connectedSessionByDevice[deviceId] == sessionId,
          peripheral.state == .connected,
          let characteristic = characteristic(
            peripheral: peripheral,
            serviceUuid: serviceUuid,
            characteristicUuid: characteristicUuid
          ) else {
      failHardwareStream(
        streamId: streamId,
        sessionId: sessionId,
        code: "hardware_not_ready",
        message: "the requested BLE characteristic is not connected for this session"
      )
      return
    }
    guard characteristic.properties.contains(.notify) || characteristic.properties.contains(.indicate) else {
      failHardwareStream(
        streamId: streamId,
        sessionId: sessionId,
        code: "hardware_unsupported",
        message: "the requested characteristic does not support notifications"
      )
      return
    }
    guard bindNotificationCharacteristic(
      streamId: streamId,
      sessionId: sessionId,
      characteristic: characteristic
    ) else { return }
    let key = bleOperationKey(
      deviceId: deviceId,
      serviceUuid: serviceUuid,
      characteristicUuid: characteristicUuid
    )
    let state = notificationStates[key] ?? {
      let value = PocketNotificationState(
        key: key,
        deviceId: deviceId,
        serviceUuid: serviceUuid,
        characteristicUuid: characteristicUuid,
        sessionId: sessionId,
        peripheral: peripheral,
        characteristic: characteristic
      )
      notificationStates[key] = value
      return value
    }()
    guard state.sessionId == sessionId,
          state.peripheral === peripheral,
          state.characteristic === characteristic else {
      failHardwareStream(
        streamId: streamId,
        sessionId: sessionId,
        code: "hardware_owner_mismatch",
        message: "notification characteristic is owned by another hardware session"
      )
      return
    }
    state.streamIds.insert(streamId)
    if state.enabled, !state.disabling {
      markNotificationStreamReady(streamId: streamId, sessionId: sessionId)
    } else if !state.enabling && !state.disabling {
      state.enabling = true
      enqueueNotificationCccd(state: state, enable: true)
    }
  }

  private func markNotificationStreamReady(streamId: String, sessionId: String) {
    streamQueue.async {
      guard let state = self.hardwareStreams[streamId],
            state.sessionId == sessionId else { return }
      state.ready = true
      let startResult = state.startResult
      state.startResult = nil
      self.main {
        startResult?(["ok": true, "streamId": streamId, "kind": "ble.notifications", "realHardware": true])
      }
    }
  }

  private func failHardwareStream(
    streamId: String,
    sessionId: String,
    code: String,
    message: String
  ) {
    streamQueue.async {
      guard let state = self.hardwareStreams[streamId],
            state.sessionId == sessionId else { return }
      self.hardwareStreams.removeValue(forKey: streamId)
      let startResult = state.startResult
      state.startResult = nil
      self.clearBufferedHardwareEvents(streamId: streamId)
      self.emitHardwareError(streamId: streamId, code: code, message: message)
      self.emitHardwareDone(streamId: streamId)
      self.main {
        startResult?(self.error(code: code, message: message))
      }
    }
  }

  private func cancelNotificationStream(
    streamId: String,
    deviceId: String,
    serviceUuid: String,
    characteristicUuid: String
  ) {
    let key = bleOperationKey(
      deviceId: deviceId,
      serviceUuid: serviceUuid,
      characteristicUuid: characteristicUuid
    )
    guard let state = notificationStates[key] else { return }
    state.streamIds.remove(streamId)
    if state.streamIds.isEmpty {
      if state.enabling || state.disabling { return }
      if state.enabled {
        state.disabling = true
        enqueueNotificationCccd(state: state, enable: false)
      } else {
        notificationStates.removeValue(forKey: key)
      }
    }
  }

  private func enqueueNotificationCccd(
    state: PocketNotificationState,
    enable: Bool
  ) {
    let operation = PocketGattOperation(
      deviceId: state.deviceId,
      key: state.key,
      id: nextGattOperationIdentifier(deviceId: state.deviceId),
      kind: enable ? .cccdEnable : .cccdDisable,
      peripheral: state.peripheral,
      characteristic: state.characteristic,
      serviceUuid: state.serviceUuid,
      characteristicUuid: state.characteristicUuid,
      sessionId: state.sessionId,
      result: nil,
      byteCount: 0,
      start: {
        state.peripheral.setNotifyValue(enable, for: state.characteristic)
      },
      completion: { value in
        self.handleNotificationCccdResult(
          state: state,
          enable: enable,
          value: value
        )
      }
    )
    enqueueGattOperation(operation)
  }

  private func handleNotificationCccdResult(
    state: PocketNotificationState,
    enable: Bool,
    value: [String: Any]
  ) {
    if !enable, value["ok"] as? Bool != true {
      // A failed disable leaves the peripheral's CCCD state unknown. Keeping
      // the connection alive would leak a producer (and could deliver late
      // values into a future owner), so use the same fenced device abort as a
      // GATT timeout/disconnect.
      abortGattDevice(
        deviceId: state.deviceId,
        code: "hardware_bluetooth_notification",
        message: "BLE notification disable failed"
      )
      return
    }
    if enable {
      state.enabling = false
      guard value["ok"] as? Bool == true else {
        let streamIds = Array(state.streamIds)
        state.streamIds.removeAll()
        notificationStates[state.key] = state
        state.disabling = true
        for streamId in streamIds {
          failHardwareStream(
            streamId: streamId,
            sessionId: state.sessionId,
            code: "\(value["errorCode"] ?? "hardware_bluetooth_notification")",
            message: "\(value["error"] ?? "BLE notification subscription failed")"
          )
        }
        enqueueNotificationCccd(state: state, enable: false)
        return
      }
      state.enabled = true
      if state.streamIds.isEmpty {
        state.disabling = true
        enqueueNotificationCccd(state: state, enable: false)
        return
      }
      for streamId in state.streamIds {
        markNotificationStreamReady(streamId: streamId, sessionId: state.sessionId)
      }
      return
    }
    state.disabling = false
    state.enabled = false
    if state.streamIds.isEmpty {
      notificationStates.removeValue(forKey: state.key)
    } else if !state.enabling {
      state.enabling = true
      enqueueNotificationCccd(state: state, enable: true)
    }
  }

  private func startSensorStreamProducerIfNeeded() {
    guard !sensorStreamProducerRunning else { return }
    sensorStreamProducerRunning = true
    latestStreamMotion = nil
    latestStreamPressureHpa = nil
    latestStreamRelativeAltitudeM = nil
    if motionManager.isDeviceMotionAvailable {
      motionManager.deviceMotionUpdateInterval = 1.0 / 60.0
      motionManager.startDeviceMotionUpdates(to: sensorQueue) { [weak self] value, error in
        guard let self = self else { return }
        if let error = error {
          self.failSensorStreams(code: self.isMotionAuthDenied(error) ? "hardware_permission_denied" : "hardware_sensor_error", message: error.localizedDescription)
          return
        }
        guard let value = value else { return }
        self.streamQueue.async {
          guard self.sensorStreamProducerRunning else { return }
          self.latestStreamMotion = value
          self.emitSensorStreamSamples()
        }
      }
    }
    if CMAltimeter.isRelativeAltitudeAvailable() {
      altimeter.startRelativeAltitudeUpdates(to: sensorQueue) { [weak self] value, error in
        guard let self = self else { return }
        if let error = error {
          self.failSensorStreams(
            code: CMAltimeter.authorizationStatus() == .denied || CMAltimeter.authorizationStatus() == .restricted ? "hardware_permission_denied" : "hardware_sensor_error",
            message: error.localizedDescription
          )
          return
        }
        guard let value = value else { return }
        self.streamQueue.async {
          guard self.sensorStreamProducerRunning else { return }
          self.latestStreamPressureHpa = value.pressure.doubleValue * 10.0
          self.latestStreamRelativeAltitudeM = value.relativeAltitude.doubleValue
          self.emitSensorStreamSamples()
        }
      }
    }
  }

  private func emitSensorStreamSamples() {
    guard sensorStreamProducerRunning else { return }
    let now = Date().timeIntervalSince1970
    let motion = latestStreamMotion
    guard motion != nil || latestStreamPressureHpa != nil else { return }
    let ids = hardwareStreams.values
      .filter { $0.kind == "sensors" && now - $0.lastEmission >= (1.0 / $0.samplingHz) }
      .map { state -> String in
        state.lastEmission = now
        return state.streamId
      }
    guard !ids.isEmpty else { return }
    var data: [String: Any] = [
      "realSensors": true,
      "timestamp": ISO8601DateFormatter().string(from: Date(timeIntervalSince1970: now)),
    ]
    if let motion = motion {
      data["accelX"] = motion.userAcceleration.x
      data["accelY"] = motion.userAcceleration.y
      data["accelZ"] = motion.userAcceleration.z
      data["gravityX"] = motion.gravity.x
      data["gravityY"] = motion.gravity.y
      data["gravityZ"] = motion.gravity.z
      data["gyroX"] = motion.rotationRate.x
      data["gyroY"] = motion.rotationRate.y
      data["gyroZ"] = motion.rotationRate.z
      data["pitch"] = motion.attitude.pitch
      data["roll"] = motion.attitude.roll
      data["yaw"] = motion.attitude.yaw
    }
    if let pressure = latestStreamPressureHpa { data["pressureHpa"] = pressure }
    if let altitude = latestStreamRelativeAltitudeM { data["relativeAltitudeM"] = altitude }
    for id in ids { emitHardwareEvent(streamId: id, data: data) }
  }

  private func failSensorStreams(code: String, message: String) {
    streamQueue.async {
      let ids = self.hardwareStreams.values
        .filter { $0.kind == "sensors" }
        .map { $0.streamId }
      guard !ids.isEmpty else { return }
      for id in ids {
        self.emitHardwareError(streamId: id, code: code, message: message)
        self.emitHardwareDone(streamId: id)
        self.hardwareStreams.removeValue(forKey: id)
      }
      self.stopSensorStreamProducerIfUnused()
    }
  }

  private func stopSensorStreamProducerIfUnused() {
    guard !hardwareStreams.values.contains(where: { $0.kind == "sensors" }) else { return }
    guard sensorStreamProducerRunning else { return }
    sensorStreamProducerRunning = false
    motionManager.stopDeviceMotionUpdates()
    altimeter.stopRelativeAltitudeUpdates()
    latestStreamMotion = nil
    latestStreamPressureHpa = nil
    latestStreamRelativeAltitudeM = nil
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
        "sensors": {
          let motionAvailable = CMMotionManager().isDeviceMotionAvailable
          let altitudeAvailable = CMAltimeter.isRelativeAltitudeAvailable()
          let supported = motionAvailable || altitudeAvailable
          if !altitudeAvailable {
            return permissionState(
              supported: supported,
              status: supported ? (self.motionAccessVerified ? "granted" : "available") : "unavailable",
              granted: supported && self.motionAccessVerified
            )
          }
          switch CMAltimeter.authorizationStatus() {
          case .authorized:
            return permissionState(supported: supported, status: "granted", granted: true)
          case .denied, .restricted:
            return permissionState(supported: supported, status: "denied", granted: false)
          case .notDetermined:
            return permissionState(supported: supported, status: "notDetermined", granted: false)
          @unknown default:
            return permissionState(supported: supported, status: "notDetermined", granted: false)
          }
        }(),
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

  private func requestPermission(
    _ permission: String,
    ownerToken: String? = nil,
    sessionId: String? = nil,
    operationId: Int? = nil,
    timeoutMs: Int? = nil,
    result: @escaping FlutterResult
  ) {
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
      sensorQueue.addOperation { [weak self] in
        guard let self = self else { return }
        let generation = self.supersedeSensorOperationOnQueue(
          code: "hardware_cancelled",
          message: "sensor request superseded"
        )
        let motionAvailable = self.motionManager.isDeviceMotionAvailable
        let altitudeAvailable = CMAltimeter.isRelativeAltitudeAvailable()
        guard motionAvailable || altitudeAvailable else {
          self.main {
            result(self.error(code: "hardware_unsupported", message: "motion and barometer sensors are unavailable"))
          }
          return
        }
        if altitudeAvailable {
          switch CMAltimeter.authorizationStatus() {
          case .authorized:
            self.main {
              result(["ok": true, "permission": permission, "granted": true, "status": "granted", "realHardware": true])
            }
            return
          case .denied, .restricted:
            self.main {
              result(["ok": true, "permission": permission, "granted": false, "status": "denied", "realHardware": true])
            }
            return
          case .notDetermined:
            break
          @unknown default:
            self.main {
              result(["ok": true, "permission": permission, "granted": false, "status": "notDetermined", "realHardware": true])
            }
            return
          }
        } else if self.motionAccessVerified {
          self.main {
            result(["ok": true, "permission": permission, "granted": true, "status": "granted", "realHardware": true])
          }
          return
        }

        self.sensorOwnerToken = ownerToken
        self.sensorSessionId = sessionId
        self.sensorOperationId = operationId
        self.pendingSensorResult = result
        let finishPermission: (_ overrideGranted: Bool?, _ overrideStatus: String?, _ errorPayload: [String: Any]?) -> Void = { [weak self] overrideGranted, overrideStatus, errorPayload in
          guard let self = self, self.sensorGeneration == generation, let callback = self.pendingSensorResult else {
            return
          }
          self.pendingSensorResult = nil
          self.clearSensorOperationState()
          if let errorPayload = errorPayload {
            self.main { callback(errorPayload) }
            return
          }
          let granted: Bool
          let statusString: String
          if let overrideGranted = overrideGranted, let overrideStatus = overrideStatus {
            granted = overrideGranted
            statusString = overrideStatus
          } else if altitudeAvailable {
            let status = CMAltimeter.authorizationStatus()
            granted = status == .authorized
            switch status {
            case .authorized:
              statusString = "granted"
            case .denied, .restricted:
              statusString = "denied"
            case .notDetermined:
              statusString = "notDetermined"
            @unknown default:
              statusString = "notDetermined"
            }
          } else {
            granted = self.motionAccessVerified
            statusString = granted ? "granted" : "notDetermined"
          }
          self.main {
            callback([
              "ok": true,
              "permission": permission,
              "granted": granted,
              "status": statusString,
              "realHardware": true,
            ])
          }
        }
        if altitudeAvailable {
          self.altimeter.startRelativeAltitudeUpdates(to: self.sensorQueue) { [weak self] value, error in
            guard let self = self, self.sensorGeneration == generation else { return }
            if let error = error {
              if CMAltimeter.authorizationStatus() == .denied || CMAltimeter.authorizationStatus() == .restricted || self.isMotionAuthDenied(error) {
                finishPermission(false, "denied", nil)
              } else {
                finishPermission(nil, nil, self.error(code: "hardware_sensor_error", message: error.localizedDescription))
              }
              return
            }
            if value != nil {
              finishPermission(true, "granted", nil)
            } else if CMAltimeter.authorizationStatus() != .notDetermined {
              finishPermission(nil, nil, nil)
            }
          }
        } else if motionAvailable {
          self.motionManager.deviceMotionUpdateInterval = 1.0 / 30.0
          self.motionManager.startDeviceMotionUpdates(to: self.sensorQueue) { [weak self] value, error in
            guard let self = self, self.sensorGeneration == generation else { return }
            if let error = error {
              if self.isMotionAuthDenied(error) {
                finishPermission(false, "denied", nil)
              } else {
                finishPermission(nil, nil, self.error(code: "hardware_sensor_error", message: error.localizedDescription))
              }
              return
            }
            if value != nil {
              self.motionAccessVerified = true
              finishPermission(true, "granted", nil)
            }
          }
        }
        let timeoutItem = DispatchWorkItem { [weak self] in
          self?.sensorQueue.addOperation {
            finishPermission(nil, nil, nil)
          }
        }
        self.sensorTimeout = timeoutItem
        DispatchQueue.global(qos: .utility).asyncAfter(
          deadline: .now() + self.sensorPromptDelay(timeoutMs: timeoutMs),
          execute: timeoutItem
        )
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
      self.photoCaptureGeneration &+= 1
      if let pending = self.pendingPhotoResult {
        self.pendingPhotoResult = nil
        self.pendingPhotoCaptureID = nil
        self.pendingPhotoGeneration = nil
        self.main {
          pending(FlutterError(code: "cancelled", message: "Camera preview stopped before photo capture completed", details: nil))
        }
      }
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
  private func disposeSession(
    sessionId: String?,
    sensorOwnerToken: String?,
    result: @escaping FlutterResult
  ) {
    main {
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
        let tokenMatches = sensorOwnerToken == nil || sensorOwnerToken == self.sensorOwnerToken
        let sessionMatches = sessionId == nil || sessionId == self.sensorSessionId
        let ownsSensor = tokenMatches && sessionMatches
        if ownsSensor {
          _ = self.supersedeSensorOperationOnQueue(
            code: "plugin_revoked",
            message: "hardware session disposed"
          )
        }
      }
      self.streamQueue.async {
        let ids = self.hardwareStreams.values
          .filter { sessionId == nil || $0.sessionId == sessionId }
          .map { $0.streamId }
        for id in ids {
          guard let state = self.hardwareStreams.removeValue(forKey: id) else { continue }
          if state.kind == "sensors" {
            self.stopSensorStreamProducerIfUnused()
          } else if let deviceId = state.deviceId,
                    let serviceUuid = state.serviceUuid,
                    let characteristicUuid = state.characteristicUuid {
            self.bleQueue.async {
              self.cancelNotificationStream(
                streamId: id,
                deviceId: deviceId,
                serviceUuid: serviceUuid,
                characteristicUuid: characteristicUuid
              )
            }
          }
          let pendingStart = state.startResult
          state.startResult = nil
          self.emitHardwareDone(streamId: id)
          if let pendingStart = pendingStart {
            self.main {
              pendingStart(self.error(code: "plugin_revoked", message: "hardware session disposed"))
            }
          }
        }
      }
      self.bleQueue.async {
        // Scanning is a process-wide CoreBluetooth producer, but its callback
        // still belongs to the session that started it. A newer session must
        // not stop or complete an older session's scan during cutover.
        let ownsScan = sessionId == nil || self.pendingScanSessionId == sessionId
        if ownsScan {
          self.scanGeneration &+= 1
          self.central?.stopScan()
          self.scanTimeout?.cancel()
          self.scanTimeout = nil
          self.pendingScanSessionId = nil
          if let callback = self.pendingScanResult {
            self.pendingScanResult = nil
            self.main { callback(self.error(code: "plugin_revoked", message: "hardware session disposed")) }
          }
        }
        let pendingConnections = self.pendingConnections.filter { id, _ in
          sessionId == nil || self.pendingConnectionSessions[id] == sessionId
        }
        for (id, callback) in pendingConnections {
          if let peripheral = self.discovered[id] {
            peripheral.delegate = nil
            self.central?.cancelPeripheralConnection(peripheral)
          }
          self.main { callback(self.error(code: "plugin_revoked", message: "hardware session disposed")) }
          self.pendingConnectionSessions.removeValue(forKey: id)
          self.pendingConnectionPeripherals.removeValue(forKey: id)
          self.connectionTimeouts[id]?.cancel()
          self.connectionTimeouts.removeValue(forKey: id)
          self.pendingConnections.removeValue(forKey: id)
        }
        var ownedDeviceIds = Set(self.connectedSessionByDevice.compactMap { id, owner in
          (sessionId == nil || owner == sessionId) ? id : nil
        })
        for (deviceId, operationId) in self.activeGattOperationByDevice {
          if let operation = self.pendingGattOperations[operationId],
             sessionId == nil || operation.sessionId == sessionId {
            ownedDeviceIds.insert(deviceId)
          }
        }
        for (deviceId, operations) in self.queuedGattOperations {
          if operations.contains(where: { sessionId == nil || $0.sessionId == sessionId }) {
            ownedDeviceIds.insert(deviceId)
          }
        }
        for deviceId in ownedDeviceIds {
          self.abortGattDevice(
            deviceId: deviceId,
            code: "plugin_revoked",
            message: "hardware session disposed"
          )
        }
      }
      self.cameraQueue.async {
        self.photoCaptureGeneration &+= 1
        if let callback = self.pendingPhotoResult {
          self.pendingPhotoResult = nil
          self.pendingPhotoCaptureID = nil
          self.pendingPhotoGeneration = nil
          self.main {
            callback(self.error(code: "plugin_revoked", message: "hardware session disposed"))
          }
        }
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
      self.photoCaptureGeneration &+= 1
      let generation = self.photoCaptureGeneration
      let settings = AVCapturePhotoSettings()
      if device.hasFlash { settings.flashMode = self.flashMode }
      self.pendingPhotoCaptureID = settings.uniqueID
      self.pendingPhotoGeneration = generation
      self.pendingPhotoResult = result
      output.capturePhoto(with: settings, delegate: self)
    }
  }

  func photoOutput(_ output: AVCapturePhotoOutput, didFinishProcessingPhoto photo: AVCapturePhoto, error: Error?) {
    cameraQueue.async {
      guard let captureID = self.pendingPhotoCaptureID,
            let generation = self.pendingPhotoGeneration,
            photo.resolvedSettings.uniqueID == captureID,
            self.photoCaptureGeneration == generation,
            self.pendingPhotoResult != nil else { return }
      if let error = error {
        if let callback = self.pendingPhotoResult {
          self.pendingPhotoResult = nil
          self.pendingPhotoCaptureID = nil
          self.pendingPhotoGeneration = nil
          self.main { callback(self.error(code: "hardware_capture_error", message: error.localizedDescription)) }
        }
        return
      }
      guard let data = photo.fileDataRepresentation() else {
        if let callback = self.pendingPhotoResult {
          self.pendingPhotoResult = nil
          self.pendingPhotoCaptureID = nil
          self.pendingPhotoGeneration = nil
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
            guard self.photoCaptureGeneration == generation,
                  self.pendingPhotoCaptureID == captureID,
                  let callback = self.pendingPhotoResult else { return }
            self.pendingPhotoResult = nil
            self.pendingPhotoCaptureID = nil
            self.pendingPhotoGeneration = nil
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
        }
      } catch {
        guard self.photoCaptureGeneration == generation,
              self.pendingPhotoCaptureID == captureID,
              let callback = self.pendingPhotoResult else { return }
        self.pendingPhotoResult = nil
        self.pendingPhotoCaptureID = nil
        self.pendingPhotoGeneration = nil
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

  private func startBleScan(
    timeoutMs: Int,
    sessionId: String?,
    result: @escaping FlutterResult
  ) {
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
      self.pendingScanSessionId = sessionId
      self.scanGeneration &+= 1
      let generation = self.scanGeneration
      central.scanForPeripherals(withServices: nil, options: [CBCentralManagerScanOptionAllowDuplicatesKey: false])
      let timeout = DispatchWorkItem { self.finishBleScan(generation: generation) }
      self.scanTimeout = timeout
      self.bleQueue.asyncAfter(deadline: .now() + .milliseconds(timeoutMs), execute: timeout)
    }
  }

  private func finishBleScan(generation: UInt64? = nil) {
    if let generation = generation, generation != scanGeneration { return }
    central?.stopScan()
    guard let callback = pendingScanResult else {
      pendingScanSessionId = nil
      scanTimeout = nil
      return
    }
    pendingScanResult = nil
    pendingScanSessionId = nil
    scanTimeout = nil
    let devices = discoveredInfo.values.sorted { "\($0["id"] ?? "")" < "\($1["id"] ?? "")" }
    main {
      callback(["ok": true, "realBle": true, "state": "poweredOn", "devices": devices])
    }
  }

  private func connectBleDevice(
    id: String,
    sessionId: String?,
    result: @escaping FlutterResult
  ) {
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
      if let owner = self.connectedSessionByDevice[id], owner != sessionId {
        self.main { result(self.error(code: "hardware_owner_mismatch", message: "device is owned by another hardware session")) }
        return
      }
      guard self.pendingConnections[id] == nil else {
        self.main { result(self.error(code: "hardware_busy", message: "connection is already pending")) }
        return
      }
      self.pendingConnections[id] = result
      self.pendingConnectionSessions[id] = sessionId ?? "legacy"
      self.pendingConnectionPeripherals[id] = peripheral
      peripheral.delegate = self
      self.central?.connect(peripheral, options: nil)
      let timeout = DispatchWorkItem {
        // DispatchWorkItem cancellation is cooperative; verify that this
        // timeout still owns the same connection attempt before touching the
        // peripheral or completing a result slot reused by a later attempt.
        guard self.pendingConnectionPeripherals[id] === peripheral,
              self.pendingConnections[id] != nil else { return }
        peripheral.delegate = nil
        self.central?.cancelPeripheralConnection(peripheral)
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
    let sessionId = pendingConnectionSessions.removeValue(forKey: id)
    pendingConnectionPeripherals.removeValue(forKey: id)
    if value["ok"] as? Bool == true, let sessionId = sessionId {
      connectedSessionByDevice[id] = sessionId
    }
    main { callback(value) }
  }

  func centralManagerDidUpdateState(_ central: CBCentralManager) {
    // A pending scan is completed with a structured error if Bluetooth turns
    // off while it is running; an empty result would falsely look healthy.
    guard central.state != .poweredOn else { return }
    let code = central.state == .unauthorized ? "hardware_permission_denied" : "hardware_bluetooth_unavailable"
    if pendingScanResult != nil {
      scanGeneration &+= 1
      scanTimeout?.cancel()
      scanTimeout = nil
      let callback = pendingScanResult
      pendingScanResult = nil
      pendingScanSessionId = nil
      main { callback?(self.error(code: code, message: "Bluetooth became unavailable")) }
    }
    let pendingConnectionIds = Array(pendingConnections.keys)
    for id in pendingConnectionIds {
      if let peripheral = discovered[id] {
        peripheral.delegate = nil
        central.cancelPeripheralConnection(peripheral)
      }
      finishConnection(
        id: id,
        value: self.error(code: code, message: "Bluetooth became unavailable")
      )
    }
    var deviceIds = Set(connectedSessionByDevice.keys)
    deviceIds.formUnion(activeGattOperationByDevice.keys)
    deviceIds.formUnion(queuedGattOperations.keys)
    for deviceId in deviceIds {
      abortGattDevice(
        deviceId: deviceId,
        code: code,
        message: "Bluetooth became unavailable",
        cancelPeripheral: false
      )
    }
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
    let id = peripheral.identifier.uuidString
    guard pendingConnectionPeripherals[id] === peripheral else {
      peripheral.delegate = nil
      return
    }
    peripheral.delegate = self
    peripheral.discoverServices(nil)
  }

  func centralManager(_ central: CBCentralManager, didFailToConnect peripheral: CBPeripheral, error: Error?) {
    let id = peripheral.identifier.uuidString
    guard pendingConnectionPeripherals[id] === peripheral else {
      peripheral.delegate = nil
      return
    }
    finishConnection(id: id, value: self.error(code: "hardware_bluetooth_connect", message: error?.localizedDescription ?? "Bluetooth connection failed"))
  }

  func centralManager(_ central: CBCentralManager, didDisconnectPeripheral peripheral: CBPeripheral, error: Error?) {
    let deviceId = peripheral.identifier.uuidString
    let message = error?.localizedDescription ?? "Bluetooth peripheral disconnected"
    guard pendingConnectionPeripherals[deviceId] === peripheral ||
          connectedSessionByDevice[deviceId] != nil ||
          activeGattOperationByDevice[deviceId] != nil else {
      peripheral.delegate = nil
      return
    }
    if pendingConnections[deviceId] != nil {
      finishConnection(
        id: deviceId,
        value: self.error(code: "hardware_bluetooth_disconnected", message: message)
      )
    }
    peripheral.delegate = nil
    self.abortGattDevice(
      deviceId: deviceId,
      code: "hardware_bluetooth_disconnected",
      message: message,
      cancelPeripheral: false
    )
  }

  func peripheral(_ peripheral: CBPeripheral, didDiscoverServices error: Error?) {
    let id = peripheral.identifier.uuidString
    guard pendingConnectionPeripherals[id] === peripheral else {
      peripheral.delegate = nil
      return
    }
    if let error = error {
      finishConnection(id: id, value: self.error(code: "hardware_bluetooth_services", message: error.localizedDescription))
      return
    }
    let services = peripheral.services ?? []
    if services.isEmpty {
      finishConnection(id: id, value: [
        "ok": true,
        "realBle": true,
        "device": id,
        "state": "connected",
        "services": [],
        "serviceUuids": [],
      ])
      return
    }
    for service in services {
      peripheral.discoverCharacteristics(nil, for: service)
    }
  }

  func peripheral(
    _ peripheral: CBPeripheral,
    didDiscoverCharacteristicsFor service: CBService,
    error: Error?
  ) {
    let id = peripheral.identifier.uuidString
    guard pendingConnectionPeripherals[id] === peripheral else {
      peripheral.delegate = nil
      return
    }
    if let error = error {
      finishConnection(id: id, value: self.error(code: "hardware_bluetooth_characteristics", message: error.localizedDescription))
      return
    }
    guard let services = peripheral.services,
          services.allSatisfy({ $0.characteristics != nil }) else {
      return
    }
    let serviceValues: [[String: Any]] = services.map { item in
      let characteristics: [[String: Any]] = (item.characteristics ?? []).map { characteristic in
        [
          "uuid": characteristic.uuid.uuidString,
          "properties": characteristicPropertyNames(characteristic.properties),
          "canRead": characteristic.properties.contains(.read),
          "canWrite": characteristic.properties.contains(.write),
          "canWriteWithoutResponse": characteristic.properties.contains(.writeWithoutResponse),
          "canNotify": characteristic.properties.contains(.notify),
          "canIndicate": characteristic.properties.contains(.indicate),
          "notifying": characteristic.isNotifying,
        ]
      }
      return [
        "uuid": item.uuid.uuidString,
        "characteristics": characteristics,
      ]
    }
    finishConnection(id: id, value: [
      "ok": true,
      "realBle": true,
      "device": id,
      "state": "connected",
      "services": serviceValues,
      "serviceUuids": services.map { $0.uuid.uuidString },
    ])
  }

  private func characteristic(
    peripheral: CBPeripheral,
    serviceUuid: String,
    characteristicUuid: String
  ) -> CBCharacteristic? {
    guard let service = peripheral.services?.first(where: {
      $0.uuid.uuidString.caseInsensitiveCompare(serviceUuid) == .orderedSame
    }) else { return nil }
    return service.characteristics?.first(where: {
      $0.uuid.uuidString.caseInsensitiveCompare(characteristicUuid) == .orderedSame
    })
  }

  private func sameCharacteristic(
    _ lhs: CBCharacteristic?,
    _ rhs: CBCharacteristic
  ) -> Bool {
    guard let lhs = lhs else { return false }
    return lhs === rhs
  }

  private func bleOperationKey(
    deviceId: String,
    serviceUuid: String,
    characteristicUuid: String
  ) -> String {
    "\(deviceId.lowercased())|\(serviceUuid.lowercased())|\(characteristicUuid.lowercased())"
  }

  private func enqueueGattOperation(_ operation: PocketGattOperation) {
    let deviceId = operation.deviceId
    if activeGattOperationByDevice[deviceId] != nil {
      queuedGattOperations[deviceId, default: []].append(operation)
      return
    }
    startGattOperation(operation)
  }

  private func startGattOperation(_ operation: PocketGattOperation) {
    let deviceId = operation.deviceId
    activeGattOperationByDevice[deviceId] = operation.id
    pendingGattOperations[operation.id] = operation
    if operation.kind == .write || operation.kind == .writeWithoutResponse {
      let writeType: CBCharacteristicWriteType = operation.kind == .write
        ? .withResponse
        : .withoutResponse
      let maximumLength = operation.peripheral.maximumWriteValueLength(for: writeType)
      guard operation.byteCount <= maximumLength else {
        finishGattOperation(
          id: operation.id,
          value: self.error(
            code: "invalid_argument",
            message: "BLE write value exceeds the peripheral maximum of \(maximumLength) bytes"
          )
        )
        return
      }
      if operation.kind == .writeWithoutResponse,
         !operation.peripheral.canSendWriteWithoutResponse {
        finishGattOperation(
          id: operation.id,
          value: self.error(
            code: "hardware_busy",
            message: "BLE peripheral is not ready for a write without response; retry later"
          )
        )
        return
      }
    }
    operation.start()
    if let immediateResult = operation.immediateResult {
      finishGattOperation(id: operation.id, value: immediateResult)
      return
    }
    let timeout = DispatchWorkItem { [weak self] in
      guard let self = self else { return }
      // Cancellation of a DispatchWorkItem is cooperative. The timeout may
      // already be dequeued after a normal callback completed this operation;
      // it must not abort a newer operation on the same peripheral.
      guard self.activeGattOperationByDevice[operation.deviceId] == operation.id,
            self.pendingGattOperations[operation.id] != nil else { return }
      self.abortGattDevice(
        deviceId: operation.deviceId,
        code: "hardware_timeout",
        message: "BLE characteristic operation timed out"
      )
    }
    operation.timeout = timeout
    bleQueue.asyncAfter(deadline: .now() + 10, execute: timeout)
  }

  private func startNextGattOperation(for deviceId: String) {
    guard activeGattOperationByDevice[deviceId] == nil,
          var queue = queuedGattOperations.removeValue(forKey: deviceId),
          !queue.isEmpty else { return }
    let next = queue.removeFirst()
    if !queue.isEmpty { queuedGattOperations[deviceId] = queue }
    startGattOperation(next)
  }

  private func nextGattOperationIdentifier(deviceId: String) -> String {
    nextGattOperationId &+= 1
    return "\(deviceId.lowercased())#\(nextGattOperationId)"
  }

  private func activeGattOperation(
    deviceId: String,
    peripheral: CBPeripheral,
    characteristic: CBCharacteristic,
    serviceUuid: String,
    characteristicUuid: String,
    kind: PocketGattOperationKind
  ) -> PocketGattOperation? {
    guard let id = activeGattOperationByDevice[deviceId],
          let operation = pendingGattOperations[id],
          operation.peripheral === peripheral,
          operation.characteristic === characteristic,
          operation.kind == kind,
          operation.serviceUuid.caseInsensitiveCompare(serviceUuid) == .orderedSame,
          operation.characteristicUuid.caseInsensitiveCompare(characteristicUuid) == .orderedSame else {
      return nil
    }
    return operation
  }

  private func finishGattOperation(
    id: String,
    value: [String: Any],
    advance: Bool = true
  ) {
    guard let operation = pendingGattOperations.removeValue(forKey: id) else { return }
    operation.timeout?.cancel()
    operation.timeout = nil
    if activeGattOperationByDevice[operation.deviceId] == id {
      activeGattOperationByDevice.removeValue(forKey: operation.deviceId)
    }
    operation.completion?(value)
    if let result = operation.result {
      main { result(value) }
    }
    if advance {
      startNextGattOperation(for: operation.deviceId)
    }
  }

  private func abortGattDevice(
    deviceId: String,
    code: String,
    message: String,
    cancelPeripheral: Bool = true
  ) {
    let failure = error(code: code, message: message)
    var operations: [PocketGattOperation] = []
    if let activeId = activeGattOperationByDevice.removeValue(forKey: deviceId),
       let operation = pendingGattOperations.removeValue(forKey: activeId) {
      operations.append(operation)
    }
    operations.append(contentsOf: queuedGattOperations.removeValue(forKey: deviceId) ?? [])
    let notificationKeys = notificationStates.keys.filter {
      $0.hasPrefix("\(deviceId.lowercased())|")
    }
    for key in notificationKeys {
      notificationStates.removeValue(forKey: key)
    }
    for operation in operations {
      operation.timeout?.cancel()
      operation.timeout = nil
      // A CCCD completion reconciles the desired notification state and may
      // enqueue another CCCD operation. During an abort that state has
      // already been removed and every stream has been failed below; invoking
      // the old completion would resurrect a producer after timeout or
      // disconnect. Read/write operations have no producer-side completion.
      if operation.kind != .cccdEnable && operation.kind != .cccdDisable {
        operation.completion?(failure)
      }
      if let result = operation.result {
        main { result(failure) }
      }
    }
    let peripheral = operations.first?.peripheral ?? discovered[deviceId]
    if let peripheral = peripheral {
      // Detach before canceling (or before leaving a Bluetooth-unavailable
      // state) so callbacks from the invalidated operation cannot be
      // delivered to a later operation on this peripheral.
      peripheral.delegate = nil
      if cancelPeripheral && (peripheral.state == .connected || peripheral.state == .connecting) {
        central?.cancelPeripheralConnection(peripheral)
      }
    }
    connectedSessionByDevice.removeValue(forKey: deviceId)
    streamQueue.async {
      let ids = self.hardwareStreams.values
        .filter { $0.deviceId?.caseInsensitiveCompare(deviceId) == .orderedSame }
        .map { $0.streamId }
      for id in ids {
        guard let state = self.hardwareStreams.removeValue(forKey: id) else { continue }
        let pendingStart = state.startResult
        state.startResult = nil
        self.emitHardwareError(streamId: id, code: code, message: message)
        self.emitHardwareDone(streamId: id)
        self.main {
          pendingStart?(failure)
        }
      }
    }
  }

  private func readBleCharacteristic(
    deviceId: String,
    serviceUuid: String,
    characteristicUuid: String,
    sessionId: String?,
    result: @escaping FlutterResult
  ) {
    guard !deviceId.isEmpty, !serviceUuid.isEmpty, !characteristicUuid.isEmpty,
          let sessionId = sessionId, !sessionId.isEmpty else {
      result(error(code: "invalid_argument", message: "deviceId, serviceUuid, characteristicUuid, and sessionId are required"))
      return
    }
    bleQueue.async {
      guard let peripheral = self.discovered[deviceId], peripheral.state == .connected else {
        self.main { result(self.error(code: "hardware_not_ready", message: "BLE device is not connected")) }
        return
      }
      guard self.connectedSessionByDevice[deviceId] == sessionId else {
        self.main { result(self.error(code: "hardware_owner_mismatch", message: "device is owned by another hardware session")) }
        return
      }
      guard let characteristic = self.characteristic(
        peripheral: peripheral,
        serviceUuid: serviceUuid,
        characteristicUuid: characteristicUuid
      ) else {
        self.main { result(self.error(code: "hardware_not_found", message: "BLE characteristic was not discovered")) }
        return
      }
      guard characteristic.properties.contains(.read) else {
        self.main { result(self.error(code: "hardware_unsupported", message: "BLE characteristic is not readable")) }
        return
      }
      let key = self.bleOperationKey(
        deviceId: deviceId,
        serviceUuid: serviceUuid,
        characteristicUuid: characteristicUuid
      )
      if characteristic.isNotifying || self.notificationStates[key]?.streamIds.isEmpty == false {
        self.main {
          result(self.error(
            code: "hardware_busy",
            message: "BLE reads are unavailable while notifications are active for this characteristic"
          ))
        }
        return
      }
      let operation = PocketGattOperation(
        deviceId: deviceId,
        key: key,
        id: self.nextGattOperationIdentifier(deviceId: deviceId),
        kind: .read,
        peripheral: peripheral,
        characteristic: characteristic,
        serviceUuid: serviceUuid,
        characteristicUuid: characteristicUuid,
        sessionId: sessionId,
        result: result,
        byteCount: 0,
        start: { peripheral.readValue(for: characteristic) }
      )
      self.enqueueGattOperation(operation)
    }
  }

  private func writeBleCharacteristic(
    deviceId: String,
    serviceUuid: String,
    characteristicUuid: String,
    value: [Any],
    withResponse: Bool,
    sessionId: String?,
    result: @escaping FlutterResult
  ) {
    guard !deviceId.isEmpty, !serviceUuid.isEmpty, !characteristicUuid.isEmpty,
          let sessionId = sessionId, !sessionId.isEmpty else {
      result(error(code: "invalid_argument", message: "deviceId, serviceUuid, characteristicUuid, and sessionId are required"))
      return
    }
    var bytes: [UInt8] = []
    for item in value {
      guard let number = item as? NSNumber,
            number.doubleValue.isFinite,
            number.doubleValue.rounded() == number.doubleValue,
            number.intValue >= 0,
            number.intValue <= 255 else {
        result(error(code: "invalid_argument", message: "value must contain only bytes between 0 and 255"))
        return
      }
      bytes.append(UInt8(number.intValue))
    }
    guard bytes.count <= 512 else {
      result(error(code: "invalid_argument", message: "value must not exceed 512 bytes"))
      return
    }
    bleQueue.async {
      guard let peripheral = self.discovered[deviceId], peripheral.state == .connected else {
        self.main { result(self.error(code: "hardware_not_ready", message: "BLE device is not connected")) }
        return
      }
      guard self.connectedSessionByDevice[deviceId] == sessionId else {
        self.main { result(self.error(code: "hardware_owner_mismatch", message: "device is owned by another hardware session")) }
        return
      }
      guard let characteristic = self.characteristic(
        peripheral: peripheral,
        serviceUuid: serviceUuid,
        characteristicUuid: characteristicUuid
      ) else {
        self.main { result(self.error(code: "hardware_not_found", message: "BLE characteristic was not discovered")) }
        return
      }
      let property: CBCharacteristicProperties = withResponse ? .write : .writeWithoutResponse
      guard characteristic.properties.contains(property) else {
        self.main { result(self.error(code: "hardware_unsupported", message: "BLE characteristic does not support the requested write mode")) }
        return
      }
      let key = self.bleOperationKey(
        deviceId: deviceId,
        serviceUuid: serviceUuid,
        characteristicUuid: characteristicUuid
      )
      if withResponse {
        let operation = PocketGattOperation(
          deviceId: deviceId,
          key: key,
        id: self.nextGattOperationIdentifier(deviceId: deviceId),
        kind: .write,
        peripheral: peripheral,
        characteristic: characteristic,
        serviceUuid: serviceUuid,
        characteristicUuid: characteristicUuid,
          sessionId: sessionId,
          result: result,
          byteCount: bytes.count,
          start: {
            peripheral.writeValue(Data(bytes), for: characteristic, type: .withResponse)
          }
        )
        self.enqueueGattOperation(operation)
      } else {
        let operation = PocketGattOperation(
          deviceId: deviceId,
          key: key,
          id: self.nextGattOperationIdentifier(deviceId: deviceId),
          kind: .writeWithoutResponse,
          peripheral: peripheral,
          characteristic: characteristic,
          serviceUuid: serviceUuid,
          characteristicUuid: characteristicUuid,
          sessionId: sessionId,
          result: result,
          byteCount: bytes.count,
          start: {
            peripheral.writeValue(Data(bytes), for: characteristic, type: .withoutResponse)
          },
          immediateResult: [
            "ok": true,
            "realBle": true,
            "deviceId": deviceId,
            "serviceUuid": serviceUuid,
            "characteristicUuid": characteristicUuid,
            "bytesWritten": bytes.count,
            "written": true,
            "withResponse": false,
          ]
        )
        self.enqueueGattOperation(operation)
      }
    }
  }

  func peripheral(
    _ peripheral: CBPeripheral,
    didUpdateValueFor characteristic: CBCharacteristic,
    error: Error?
  ) {
    let deviceId = peripheral.identifier.uuidString
    let serviceUuid = characteristic.service?.uuid.uuidString ?? ""
    let characteristicUuid = characteristic.uuid.uuidString
    let key = bleOperationKey(
      deviceId: deviceId,
      serviceUuid: serviceUuid,
      characteristicUuid: characteristicUuid
    )
    if let error = error {
      if let operation = activeGattOperation(
        deviceId: deviceId,
        peripheral: peripheral,
        characteristic: characteristic,
        serviceUuid: serviceUuid,
        characteristicUuid: characteristicUuid,
        kind: .read
      ) {
        finishGattOperation(
          id: operation.id,
          value: self.error(code: "hardware_bluetooth_read", message: error.localizedDescription)
        )
        // This callback was consumed by the serialized read. CoreBluetooth
        // uses the same delegate method for notifications, so do not also
        // tear down a notification stream for a read error on this
        // characteristic.
        return
      }
      failNotificationStreams(
        deviceId: deviceId,
        serviceUuid: serviceUuid,
        characteristicUuid: characteristicUuid,
        characteristic: characteristic,
        code: "hardware_bluetooth_notification",
        message: error.localizedDescription
      )
      return
    }
    // A read result is consumed only while a matching read operation is
    // active and carries the exact CBCharacteristic object that was passed to
    // readValue. Once no read matches, only a ready notification stream bound
    // to that same characteristic object may receive this callback. This is
    // the explicit read/notify policy for CoreBluetooth's shared delegate
    // method; a notification can never complete a read operation.
    if let operation = activeGattOperation(
       deviceId: deviceId,
       peripheral: peripheral,
       characteristic: characteristic,
       serviceUuid: serviceUuid,
       characteristicUuid: characteristicUuid,
       kind: .read
    ),
       operation.sessionId == connectedSessionByDevice[deviceId],
       let data = characteristic.value {
      finishGattOperation(id: operation.id, value: [
        "ok": true,
        "realBle": true,
        "device": deviceId,
        "deviceId": deviceId,
        "serviceUuid": serviceUuid,
        "characteristicUuid": characteristicUuid,
        "value": data.map { Int($0) },
      ])
    }
    guard let data = characteristic.value else { return }
    streamQueue.async {
      let states = self.hardwareStreams.values.filter {
        $0.kind == "ble.notifications" &&
          $0.ready &&
          $0.deviceId?.caseInsensitiveCompare(deviceId) == .orderedSame &&
          $0.serviceUuid?.caseInsensitiveCompare(serviceUuid) == .orderedSame &&
          $0.characteristicUuid?.caseInsensitiveCompare(characteristicUuid) == .orderedSame &&
          self.sameCharacteristic($0.characteristic, characteristic) &&
          $0.sessionId == self.connectedSessionByDevice[deviceId]
      }
      let value = data.map { Int($0) }
      for state in states {
        self.emitHardwareEvent(streamId: state.streamId, data: [
          "realBle": true,
            "device": deviceId,
          "deviceId": deviceId,
          "serviceUuid": serviceUuid,
          "characteristicUuid": characteristicUuid,
          "value": value,
          "timestampMs": Int(Date().timeIntervalSince1970 * 1000),
        ])
      }
    }
  }

  func peripheral(
    _ peripheral: CBPeripheral,
    didWriteValueFor characteristic: CBCharacteristic,
    error: Error?
  ) {
    let deviceId = peripheral.identifier.uuidString
    guard let operation = activeGattOperation(
      deviceId: deviceId,
      peripheral: peripheral,
      characteristic: characteristic,
      serviceUuid: characteristic.service?.uuid.uuidString ?? "",
      characteristicUuid: characteristic.uuid.uuidString,
      kind: .write
    ) else { return }
    if let error = error {
      finishGattOperation(id: operation.id, value: self.error(code: "hardware_bluetooth_write", message: error.localizedDescription))
    } else {
      finishGattOperation(id: operation.id, value: [
        "ok": true,
        "realBle": true,
        "device": peripheral.identifier.uuidString,
        "deviceId": peripheral.identifier.uuidString,
        "serviceUuid": characteristic.service?.uuid.uuidString ?? "",
        "characteristicUuid": characteristic.uuid.uuidString,
        "bytesWritten": operation.byteCount,
        "written": true,
        "withResponse": true,
      ])
    }
  }

  func peripheral(
    _ peripheral: CBPeripheral,
    didUpdateNotificationStateFor characteristic: CBCharacteristic,
    error: Error?
  ) {
    let deviceId = peripheral.identifier.uuidString
    let serviceUuid = characteristic.service?.uuid.uuidString ?? ""
    let characteristicUuid = characteristic.uuid.uuidString
    if let operation = activeGattOperation(
      deviceId: deviceId,
      peripheral: peripheral,
      characteristic: characteristic,
      serviceUuid: serviceUuid,
      characteristicUuid: characteristicUuid,
      kind: .cccdEnable
    ) {
      if let error = error {
        finishGattOperation(
          id: operation.id,
          value: self.error(code: "hardware_bluetooth_notification", message: error.localizedDescription)
        )
      } else if characteristic.isNotifying {
        finishGattOperation(id: operation.id, value: ["ok": true])
      } else {
        finishGattOperation(
          id: operation.id,
          value: self.error(code: "hardware_bluetooth_notification", message: "BLE notification subscription was rejected")
        )
      }
      return
    }
    if let operation = activeGattOperation(
      deviceId: deviceId,
      peripheral: peripheral,
      characteristic: characteristic,
      serviceUuid: serviceUuid,
      characteristicUuid: characteristicUuid,
      kind: .cccdDisable
    ) {
      if let error = error {
        finishGattOperation(
          id: operation.id,
          value: self.error(code: "hardware_bluetooth_notification", message: error.localizedDescription)
        )
      } else if !characteristic.isNotifying {
        finishGattOperation(id: operation.id, value: ["ok": true])
      } else {
        finishGattOperation(
          id: operation.id,
          value: self.error(code: "hardware_bluetooth_notification", message: "BLE notification disable was rejected")
        )
      }
      return
    }
    if error != nil || !characteristic.isNotifying {
      failNotificationStreams(
        deviceId: deviceId,
        serviceUuid: serviceUuid,
        characteristicUuid: characteristicUuid,
        characteristic: characteristic,
        code: "hardware_bluetooth_notification",
        message: error?.localizedDescription ?? "BLE notification subscription was rejected"
      )
    }
  }

  private func failNotificationStreams(
    deviceId: String,
    serviceUuid: String,
    characteristicUuid: String,
    characteristic: CBCharacteristic? = nil,
    code: String,
    message: String
  ) {
    let key = bleOperationKey(
      deviceId: deviceId,
      serviceUuid: serviceUuid,
      characteristicUuid: characteristicUuid
    )
    let ids = streamQueue.sync {
      hardwareStreams.values.filter {
        $0.kind == "ble.notifications" &&
          $0.deviceId?.caseInsensitiveCompare(deviceId) == .orderedSame &&
          $0.serviceUuid?.caseInsensitiveCompare(serviceUuid) == .orderedSame &&
          $0.characteristicUuid?.caseInsensitiveCompare(characteristicUuid) == .orderedSame &&
          characteristic == nil || self.sameCharacteristic($0.characteristic, characteristic!)
      }.map { $0.streamId }
    }
    let notificationSessionId = notificationStates[key]?.sessionId
    if let state = notificationStates[key] {
      state.streamIds.subtract(ids)
      if state.streamIds.isEmpty {
        if state.enabling || state.disabling {
          // The in-flight operation will reconcile the empty desired set.
        } else if state.enabled {
          state.disabling = true
          enqueueNotificationCccd(state: state, enable: false)
        } else {
          notificationStates.removeValue(forKey: key)
        }
      }
    }
    for id in ids {
      failHardwareStream(
        streamId: id,
        sessionId: notificationSessionId ?? connectedSessionByDevice[deviceId] ?? "",
        code: code,
        message: message
      )
    }
  }

  // MARK: - Sensors, biometrics and location

  private func supersedeSensorOperationOnQueue(
    code: String,
    message: String
  ) -> UInt64 {
    self.sensorGeneration &+= 1
    self.clearSensorOperationState()
    if let previous = self.pendingSensorResult {
      self.pendingSensorResult = nil
      self.main {
        previous(self.error(code: code, message: message))
      }
    }
    return self.sensorGeneration
  }

  private func clearSensorOperationState() {
    self.sensorOwnerToken = nil
    self.sensorSessionId = nil
    self.sensorOperationId = nil
    self.sensorTimeout?.cancel()
    self.sensorTimeout = nil
    self.motionManager.stopDeviceMotionUpdates()
    self.altimeter.stopRelativeAltitudeUpdates()
  }

  private func sensorIdentityMatches(
    ownerToken: String?,
    operationId: Int?
  ) -> Bool {
    // A token-owned operation can only be cancelled by the complete new
    // identity.  In particular, an old/omitted cancel or an owner-only cancel
    // must never stop a newer plugin's provider.
    if let currentOwnerToken = self.sensorOwnerToken {
      guard let ownerToken = ownerToken, let operationId = operationId else {
        return false
      }
      return currentOwnerToken == ownerToken && self.sensorOperationId == operationId
    }
    // Preserve low-level callers that predate owner tokens: an operation with
    // no owner can still be cancelled by its legacy operationId, or by the
    // old no-argument wildcard form.
    if ownerToken != nil {
      return false
    }
    if let operationId = operationId {
      return self.sensorOperationId == operationId
    }
    return true
  }

  private func cancelSensorOperation(
    ownerToken: String?,
    operationId: Int?,
    result: @escaping FlutterResult
  ) {
    sensorQueue.addOperation { [weak self] in
      guard let self = self else { return }
      let cancelled: Bool
      if self.pendingSensorResult != nil && self.sensorIdentityMatches(
        ownerToken: ownerToken,
        operationId: operationId
      ) {
        _ = self.supersedeSensorOperationOnQueue(
          code: "hardware_cancelled",
          message: "sensor operation cancelled"
        )
        cancelled = true
      } else {
        cancelled = false
      }
      self.main {
        result(["ok": true, "cancelled": cancelled])
      }
    }
  }

  private func isMotionAuthDenied(_ error: Error?) -> Bool {
    guard let nsError = error as NSError? else { return false }
    return nsError.domain == CMErrorDomain &&
      nsError.code == Int(CMErrorMotionActivityNotAuthorized.rawValue)
  }

  private func sensorPromptDelay(timeoutMs: Int?) -> DispatchTimeInterval {
    guard let timeoutMs = timeoutMs, timeoutMs > 0 else {
      return .seconds(15)
    }
    // Complete slightly before the Dart caller's deadline when a long prompt
    // budget is configured, while clamping to [250ms, 15000ms].
    let effectiveMs = timeoutMs > 1000 ? min(timeoutMs - 500, 15000) : max(250, timeoutMs)
    return .milliseconds(effectiveMs)
  }

  private func readSensors(
    ownerToken: String? = nil,
    sessionId: String? = nil,
    operationId: Int? = nil,
    timeoutMs: Int? = nil,
    result: @escaping FlutterResult
  ) {
    sensorQueue.addOperation { [weak self] in
      guard let self = self else { return }
      let generation = self.supersedeSensorOperationOnQueue(
        code: "hardware_cancelled",
        message: "sensor read superseded"
      )
      let motionAvailable = self.motionManager.isDeviceMotionAvailable
      let altitudeAvailable = CMAltimeter.isRelativeAltitudeAvailable()
      guard motionAvailable || altitudeAvailable else {
        self.main { result(self.error(code: "hardware_unsupported", message: "motion and barometer sensors are unavailable")) }
        return
      }
      if altitudeAvailable {
        let status = CMAltimeter.authorizationStatus()
        if status == .denied || status == .restricted {
          self.main { result(self.error(code: "hardware_permission_denied", message: "motion and fitness permission is denied")) }
          return
        }
      }
      self.sensorOwnerToken = ownerToken
      self.sensorSessionId = sessionId
      self.sensorOperationId = operationId
      self.pendingSensorResult = result
      var motion: CMDeviceMotion?
      var pressure: Double?
      var relativeAltitude: Double?
      var sensorError: Error?
      var settleScheduled = false
      let finishSample: () -> Void = { [weak self] in
        guard let self = self, self.sensorGeneration == generation, let callback = self.pendingSensorResult else {
          return
        }
        self.pendingSensorResult = nil
        self.clearSensorOperationState()
        guard let sampledMotion = motion ?? self.motionManager.deviceMotion else {
          if let pressure = pressure {
            self.main { callback(["ok": true, "realSensors": true, "pressureHpa": pressure, "relativeAltitudeM": relativeAltitude as Any]) }
          } else if (altitudeAvailable && (CMAltimeter.authorizationStatus() == .denied || CMAltimeter.authorizationStatus() == .restricted)) || self.isMotionAuthDenied(sensorError) {
            self.main { callback(self.error(code: "hardware_permission_denied", message: "motion and fitness permission is denied")) }
          } else if let sensorError = sensorError {
            self.main { callback(self.error(code: "hardware_sensor_error", message: sensorError.localizedDescription)) }
          } else {
            self.main { callback(self.error(code: "hardware_sensor_timeout", message: "sensor sample was unavailable")) }
          }
          return
        }
        self.motionAccessVerified = true
        var values: [String: Any] = [
          "ok": true,
          "realSensors": true,
          "accelX": sampledMotion.userAcceleration.x,
          "accelY": sampledMotion.userAcceleration.y,
          "accelZ": sampledMotion.userAcceleration.z,
          "gravityX": sampledMotion.gravity.x,
          "gravityY": sampledMotion.gravity.y,
          "gravityZ": sampledMotion.gravity.z,
          "gyroX": sampledMotion.rotationRate.x,
          "gyroY": sampledMotion.rotationRate.y,
          "gyroZ": sampledMotion.rotationRate.z,
          "pitch": sampledMotion.attitude.pitch,
          "roll": sampledMotion.attitude.roll,
          "yaw": sampledMotion.attitude.yaw,
        ]
        if let pressure = pressure { values["pressureHpa"] = pressure }
        if let altitude = relativeAltitude { values["relativeAltitudeM"] = altitude }
        self.main { callback(values) }
      }
      let awaitingAuthPrompt = (altitudeAvailable && CMAltimeter.authorizationStatus() == .notDetermined) ||
        (!altitudeAvailable && motionAvailable && !self.motionAccessVerified)
      let scheduleSettle: () -> Void = { [weak self] in
        guard awaitingAuthPrompt, !settleScheduled, let self = self, self.sensorGeneration == generation else { return }
        settleScheduled = true
        self.sensorTimeout?.cancel()
        let settleItem = DispatchWorkItem { [weak self] in
          self?.sensorQueue.addOperation {
            finishSample()
          }
        }
        self.sensorTimeout = settleItem
        DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + .milliseconds(250), execute: settleItem)
      }
      if motionAvailable {
        self.motionManager.deviceMotionUpdateInterval = 1.0 / 30.0
        self.motionManager.startDeviceMotionUpdates(to: self.sensorQueue) { [weak self] value, error in
          guard let self = self, self.sensorGeneration == generation else { return }
          if let value = value {
            self.motionAccessVerified = true
            motion = value
            if !altitudeAvailable {
              scheduleSettle()
            }
          } else if let error = error {
            sensorError = error
            if self.isMotionAuthDenied(error) || !altitudeAvailable {
              finishSample()
            }
          }
        }
      }
      if altitudeAvailable {
        self.altimeter.startRelativeAltitudeUpdates(to: self.sensorQueue) { [weak self] value, error in
          guard let self = self, self.sensorGeneration == generation else { return }
          if let value = value {
            pressure = value.pressure.doubleValue * 10.0
            relativeAltitude = value.relativeAltitude.doubleValue
            scheduleSettle()
          } else if let error = error {
            sensorError = error
            if CMAltimeter.authorizationStatus() == .denied || CMAltimeter.authorizationStatus() == .restricted || self.isMotionAuthDenied(error) || !motionAvailable {
              finishSample()
            }
          }
        }
      }
      // OperationQueue is required by Core Motion and has no delayed-submit
      // API. Use a cancellable DispatchWorkItem bound to sensorGeneration so
      // disposeSession or a subsequent read cannot stop or complete a newer request.
      let timeoutItem = DispatchWorkItem { [weak self] in
        self?.sensorQueue.addOperation {
          finishSample()
        }
      }
      self.sensorTimeout = timeoutItem
      let initialDelay: DispatchTimeInterval = awaitingAuthPrompt
        ? self.sensorPromptDelay(timeoutMs: timeoutMs)
        : .milliseconds(250)
      DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + initialDelay, execute: timeoutItem)
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
      guard self.pendingLocationResult == nil else {
        result(self.error(code: "hardware_busy", message: "location request is already pending"))
        return
      }
      self.pendingLocationResult = result
      let timeout = DispatchWorkItem { [weak self] in
        guard let self = self, let callback = self.pendingLocationResult else { return }
        self.pendingLocationResult = nil
        self.locationTimeout = nil
        callback(self.error(code: "hardware_location_timeout", message: "location request timed out"))
      }
      self.locationTimeout = timeout
      DispatchQueue.main.asyncAfter(deadline: .now() + 30, execute: timeout)

      let manager = self.ensureLocationManager()
      switch manager.authorizationStatus {
      case .notDetermined:
        manager.requestWhenInUseAuthorization()
      case .authorizedAlways, .authorizedWhenInUse:
        manager.requestLocation()
      default:
        self.pendingLocationResult = nil
        self.locationTimeout?.cancel()
        self.locationTimeout = nil
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
          self.locationTimeout = nil
          callback(self.error(code: "hardware_location_timeout", message: "no location fix was received"))
        }
        locationTimeout = timeout
        DispatchQueue.main.asyncAfter(deadline: .now() + 30, execute: timeout)
      }
    } else if let callback = pendingLocationResult, status != .notDetermined {
      pendingLocationResult = nil
      locationTimeout?.cancel()
      locationTimeout = nil
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

  private func characteristicPropertyNames(_ properties: CBCharacteristicProperties) -> [String] {
    var values: [String] = []
    if properties.contains(.broadcast) { values.append("broadcast") }
    if properties.contains(.read) { values.append("read") }
    if properties.contains(.writeWithoutResponse) { values.append("writeWithoutResponse") }
    if properties.contains(.write) { values.append("write") }
    if properties.contains(.notify) { values.append("notify") }
    if properties.contains(.indicate) { values.append("indicate") }
    if properties.contains(.authenticatedSignedWrites) { values.append("authenticatedSignedWrites") }
    if properties.contains(.extendedProperties) { values.append("extendedProperties") }
    if properties.contains(.notifyEncryptionRequired) { values.append("notifyEncryptionRequired") }
    if properties.contains(.indicateEncryptionRequired) { values.append("indicateEncryptionRequired") }
    return values
  }
}

private final class PocketHardwareStreamState {
  let streamId: String
  let kind: String
  let sessionId: String
  let samplingHz: Double
  let deviceId: String?
  let serviceUuid: String?
  let characteristicUuid: String?
  var ready: Bool
  var characteristic: CBCharacteristic?
  var startResult: FlutterResult?
  var lastEmission: TimeInterval = 0

  init(
    streamId: String,
    kind: String,
    sessionId: String,
    samplingHz: Double = 10,
    deviceId: String? = nil,
    serviceUuid: String? = nil,
    characteristicUuid: String? = nil,
    ready: Bool = false,
    characteristic: CBCharacteristic? = nil,
    startResult: FlutterResult? = nil
  ) {
    self.streamId = streamId
    self.kind = kind
    self.sessionId = sessionId
    self.samplingHz = samplingHz
    self.deviceId = deviceId
    self.serviceUuid = serviceUuid
    self.characteristicUuid = characteristicUuid
    self.ready = ready
    self.characteristic = characteristic
    self.startResult = startResult
  }
}

private enum PocketGattOperationKind: Equatable {
  case read
  case write
  case writeWithoutResponse
  case cccdEnable
  case cccdDisable
}

private final class PocketNotificationState {
  let key: String
  let deviceId: String
  let serviceUuid: String
  let characteristicUuid: String
  let sessionId: String
  let peripheral: CBPeripheral
  let characteristic: CBCharacteristic
  var streamIds: Set<String> = []
  var enabled = false
  var enabling = false
  var disabling = false

  init(
    key: String,
    deviceId: String,
    serviceUuid: String,
    characteristicUuid: String,
    sessionId: String,
    peripheral: CBPeripheral,
    characteristic: CBCharacteristic
  ) {
    self.key = key
    self.deviceId = deviceId
    self.serviceUuid = serviceUuid
    self.characteristicUuid = characteristicUuid
    self.sessionId = sessionId
    self.peripheral = peripheral
    self.characteristic = characteristic
  }
}

private final class PocketGattOperation {
  let deviceId: String
  let key: String
  let id: String
  let kind: PocketGattOperationKind
  let peripheral: CBPeripheral
  let characteristic: CBCharacteristic
  let serviceUuid: String
  let characteristicUuid: String
  let sessionId: String
  let result: FlutterResult?
  let start: () -> Void
  let completion: (([String: Any]) -> Void)?
  let immediateResult: [String: Any]?
  var timeout: DispatchWorkItem?
  let byteCount: Int

  init(
    deviceId: String,
    key: String,
    id: String,
    kind: PocketGattOperationKind,
    peripheral: CBPeripheral,
    characteristic: CBCharacteristic,
    serviceUuid: String,
    characteristicUuid: String,
    sessionId: String,
    result: FlutterResult?,
    byteCount: Int,
    start: @escaping () -> Void,
    completion: (([String: Any]) -> Void)? = nil,
    immediateResult: [String: Any]? = nil
  ) {
    self.deviceId = deviceId
    self.key = key
    self.id = id
    self.kind = kind
    self.peripheral = peripheral
    self.characteristic = characteristic
    self.serviceUuid = serviceUuid
    self.characteristicUuid = characteristicUuid
    self.sessionId = sessionId
    self.result = result
    self.byteCount = byteCount
    self.start = start
    self.completion = completion
    self.immediateResult = immediateResult
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
