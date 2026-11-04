import CoreMotion
import Flutter
import Foundation

internal enum PocketSensorSamplingPolicy {
  static func periodNanoseconds(hz: Double) -> UInt64 {
    UInt64((1_000_000_000.0 / min(max(hz, 1.0), 60.0)).rounded())
  }
  static func isDue(nowNanoseconds: UInt64, lastEmissionNanoseconds: UInt64, samplingHz: Double) -> Bool {
    let period = periodNanoseconds(hz: samplingHz)
    return lastEmissionNanoseconds == 0 || (nowNanoseconds >= lastEmissionNanoseconds && nowNanoseconds - lastEmissionNanoseconds >= period)
  }
}

public final class PocketSensorsPlugin: NSObject, FlutterPlugin {
  public static func register(with registrar: FlutterPluginRegistrar) {
    PocketSensorsManager.shared.attach(registrar: registrar)
  }
}

private final class PocketSensorsManager: NSObject, FlutterStreamHandler {
  static let shared = PocketSensorsManager()
  private let channelName = "com.pocketnexus.host/hardware/sensors"
  private let eventsChannelName = "com.pocketnexus.host/hardware/sensors/events"
  private var channel: FlutterMethodChannel?
  private var eventsChannel: FlutterEventChannel?
  private var hardwareEventSink: FlutterEventSink?
  private var bufferedHardwareEvents: [[String: Any]] = []
  private let maxBufferedHardwareEvents = 64
  private let streamQueue = DispatchQueue(label: "com.pocketnexus.host.hardware.sensors.streams", qos: .userInitiated)
  private let sensorQueue: OperationQueue = {
    let queue = OperationQueue()
    queue.name = "com.pocketnexus.host.hardware.sensors"
    queue.qualityOfService = .utility
    queue.maxConcurrentOperationCount = 1
    return queue
  }()
  private lazy var motionManager = CMMotionManager()
  private lazy var altimeter = CMAltimeter()
  private var oneShotMotionManager: CMMotionManager?
  private var oneShotAltimeter: CMAltimeter?
  private var hardwareStreams: [String: PocketSensorsStreamState] = [:]
  private var sensorStreamProducerRunning = false
  private var sensorProducerSamplingHz: Double = 0
  private var sensorProducerGeneration: UInt64 = 0
  private var sensorReadUsesSharedProducer = false
  private var sharedSensorReadGeneration: UInt64?
  private var latestStreamMotion: CMDeviceMotion?
  private var latestStreamPressureHpa: Double?
  private var latestStreamRelativeAltitudeM: Double?
  private var sensorGeneration: UInt64 = 0
  private var sensorOwnerToken: String?
  private var sensorSessionId: String?
  private var sensorOperationId: Int?
  private var pendingSensorResult: FlutterResult?
  private var sensorTimeout: DispatchWorkItem?

  private override init() { super.init() }

  func attach(registrar: FlutterPluginRegistrar) {
    if channel != nil { return }
    let methodChannel = FlutterMethodChannel(name: channelName, binaryMessenger: registrar.messenger())
    channel = methodChannel
    methodChannel.setMethodCallHandler { [weak self] call, result in self?.handle(call, result: result) }
    let eventChannel = FlutterEventChannel(name: eventsChannelName, binaryMessenger: registrar.messenger())
    eventsChannel = eventChannel
    eventChannel.setStreamHandler(self)
  }

  func detach() {
    disposeSession(sessionId: nil, sensorOwnerToken: nil) { _ in
      self.channel?.setMethodCallHandler(nil)
      self.eventsChannel?.setStreamHandler(nil)
      self.channel = nil; self.eventsChannel = nil
      self.hardwareEventSink = nil; self.bufferedHardwareEvents.removeAll()
    }
  }

  private func handle(_ call: FlutterMethodCall, result: @escaping FlutterResult) {
    let args = call.arguments as? [String: Any] ?? [:]
    switch call.method {
    case "readSensors":
      readSensors(ownerToken: args["ownerToken"] as? String, sessionId: args["sessionId"] as? String, operationId: args["operationId"] as? Int, timeoutMs: args["timeoutMs"] as? Int, result: result)
    case "cancelSensorOperation":
      cancelSensorOperation(ownerToken: args["ownerToken"] as? String, operationId: args["operationId"] as? Int, result: result)
    case "startHardwareStream":
      startHardwareStream(streamId: args["streamId"] as? String ?? "", sessionId: args["sessionId"] as? String, args: args, result: result)
    case "stopHardwareStream":
      stopHardwareStream(streamId: args["streamId"] as? String ?? "", sessionId: args["sessionId"] as? String, result: result)
    case "disposeSession":
      disposeSession(sessionId: args["sessionId"] as? String, sensorOwnerToken: args["sensorOwnerToken"] as? String, result: result)
    default:
      result(error(code: "hardware_unsupported", message: "unknown sensor method: \(call.method)"))
    }
  }

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

  private func startHardwareStream(streamId: String, sessionId: String?, args: [String: Any], result: @escaping FlutterResult) {
    guard !streamId.isEmpty, let sessionId = sessionId, !sessionId.isEmpty else {
      result(error(code: "invalid_argument", message: "streamId and sessionId are required")); return
    }
    streamQueue.async {
      guard self.hardwareStreams[streamId] == nil else {
        self.main { result(self.error(code: "hardware_stream_exists", message: "hardware stream id is already active")) }; return
      }
      let rawHz = (args["samplingHz"] as? NSNumber)?.doubleValue ?? 10.0
      guard rawHz.isFinite, rawHz >= 1.0, rawHz <= 60.0 else {
        self.main { result(self.error(code: "invalid_argument", message: "samplingHz must be between 1 and 60")) }; return
      }
      let motionAvailable = self.motionManager.isDeviceMotionAvailable
      let altitudeAvailable = CMAltimeter.isRelativeAltitudeAvailable()
      guard motionAvailable || altitudeAvailable else {
        self.main { result(self.error(code: "hardware_unsupported", message: "motion and barometer sensors are unavailable")) }; return
      }
      if let permissionError = self.sensorPermissionError(motionAvailable: motionAvailable, altitudeAvailable: altitudeAvailable) {
        self.main { result(permissionError) }; return
      }
      self.hardwareStreams[streamId] = PocketSensorsStreamState(streamId: streamId, kind: "sensors", sessionId: sessionId, samplingHz: rawHz, ready: true)
      self.startSensorStreamProducerIfNeeded()
      self.main { result(["ok": true, "streamId": streamId, "kind": "sensors", "realHardware": true]) }
    }
  }

  private func stopHardwareStream(streamId: String, sessionId: String?, result: @escaping FlutterResult) {
    guard !streamId.isEmpty, let sessionId = sessionId, !sessionId.isEmpty else {
      result(error(code: "invalid_argument", message: "streamId and sessionId are required")); return
    }
    streamQueue.async {
      guard let state = self.hardwareStreams[streamId] else {
        self.main { result(["ok": true, "streamId": streamId, "stopped": false]) }; return
      }
      guard state.sessionId == sessionId else {
        self.main { result(self.error(code: "hardware_owner_mismatch", message: "stream belongs to another hardware session")) }; return
      }
      self.hardwareStreams.removeValue(forKey: streamId)
      self.stopSensorStreamProducerIfUnused()
      self.clearBufferedHardwareEvents(streamId: streamId)
      self.emitHardwareDone(streamId: streamId)
      self.main { result(["ok": true, "streamId": streamId, "stopped": true]) }
    }
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
  private func startSensorStreamProducerIfNeeded() {
    reconfigureSensorStreamProducerIfNeeded()
  }

  /// Reconfigures one shared Core Motion producer to the maximum active watch
  /// rate.  This is called only on streamQueue, so stream add/remove and the
  /// producer's lifecycle have one owner and cannot race a one-shot manager.
  private func reconfigureSensorStreamProducerIfNeeded() {
    let streamHz = hardwareStreams.values
      .filter { $0.kind == "sensors" }
      .map { $0.samplingHz }
      .max() ?? 0
    let desiredHz = max(streamHz, sensorReadUsesSharedProducer ? 10.0 : 0)
    if desiredHz <= 0 {
      guard sensorStreamProducerRunning else { return }
      sensorProducerGeneration &+= 1
      sensorStreamProducerRunning = false
      sensorProducerSamplingHz = 0
      motionManager.stopDeviceMotionUpdates()
      altimeter.stopRelativeAltitudeUpdates()
      latestStreamMotion = nil
      latestStreamPressureHpa = nil
      latestStreamRelativeAltitudeM = nil
      return
    }
    if sensorStreamProducerRunning && abs(sensorProducerSamplingHz - desiredHz) < 0.0001 {
      return
    }
    if sensorStreamProducerRunning {
      sensorProducerGeneration &+= 1
      sensorStreamProducerRunning = false
      motionManager.stopDeviceMotionUpdates()
      altimeter.stopRelativeAltitudeUpdates()
    }
    // A changed sampling rate starts a new producer generation too. A read
    // must wait for that generation's sample rather than reuse old data.
    latestStreamMotion = nil
    latestStreamPressureHpa = nil
    latestStreamRelativeAltitudeM = nil
    sensorProducerSamplingHz = desiredHz
    sensorProducerGeneration &+= 1
    let generation = sensorProducerGeneration
    sensorStreamProducerRunning = true
    if motionManager.isDeviceMotionAvailable {
      motionManager.deviceMotionUpdateInterval = 1.0 / desiredHz
      motionManager.startDeviceMotionUpdates(to: sensorQueue) { [weak self] value, error in
        guard let self = self else { return }
        if let error = error {
          self.streamQueue.async {
            guard self.sensorStreamProducerRunning && self.sensorProducerGeneration == generation else { return }
            self.failSensorStreams(code: self.isMotionAuthDenied(error) ? "hardware_permission_denied" : "hardware_sensor_error", message: error.localizedDescription)
          }
          return
        }
        guard let value = value else { return }
        self.streamQueue.async {
          guard self.sensorStreamProducerRunning && self.sensorProducerGeneration == generation else { return }
          self.latestStreamMotion = value
          self.emitSensorStreamSamples()
          self.wakeSharedSensorReadIfPending()
        }
      }
    }
    if CMAltimeter.isRelativeAltitudeAvailable() {
      altimeter.startRelativeAltitudeUpdates(to: sensorQueue) { [weak self] value, error in
        guard let self = self else { return }
        if let error = error {
          self.streamQueue.async {
            guard self.sensorStreamProducerRunning && self.sensorProducerGeneration == generation else { return }
            self.failSensorStreams(
              code: CMAltimeter.authorizationStatus() == .denied || CMAltimeter.authorizationStatus() == .restricted ? "hardware_permission_denied" : "hardware_sensor_error",
              message: error.localizedDescription
            )
          }
          return
        }
        guard let value = value else { return }
        self.streamQueue.async {
          guard self.sensorStreamProducerRunning && self.sensorProducerGeneration == generation else { return }
          self.latestStreamPressureHpa = value.pressure.doubleValue * 10.0
          self.latestStreamRelativeAltitudeM = value.relativeAltitude.doubleValue
          self.emitSensorStreamSamples()
          self.wakeSharedSensorReadIfPending()
        }
      }
    }
  }

  private func emitSensorStreamSamples() {
    guard sensorStreamProducerRunning else { return }
    let nowNs = DispatchTime.now().uptimeNanoseconds
    let motion = latestStreamMotion
    guard motion != nil || latestStreamPressureHpa != nil else { return }
    let ids = hardwareStreams.values
      .filter {
        guard $0.kind == "sensors" else { return false }
        return PocketSensorSamplingPolicy.isDue(
          nowNanoseconds: nowNs,
          lastEmissionNanoseconds: $0.lastEmissionNs,
          samplingHz: $0.samplingHz
        )
      }
      .map { state -> String in
        state.lastEmissionNs = nowNs
        return state.streamId
      }
    guard !ids.isEmpty else { return }
    var data: [String: Any] = [
      "realSensors": true,
      "timestamp": ISO8601DateFormatter().string(from: Date()),
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
    // Called on streamQueue immediately after the producer generation guard;
    // another async hop here would let an old error affect a new producer.
    let ids = hardwareStreams.values
      .filter { $0.kind == "sensors" }
      .map { $0.streamId }
    for id in ids {
      emitHardwareError(streamId: id, code: code, message: message)
      emitHardwareDone(streamId: id)
      hardwareStreams.removeValue(forKey: id)
    }
    if let generation = sharedSensorReadGeneration {
      sensorQueue.addOperation { [weak self] in
        guard let self = self, self.sensorGeneration == generation,
              let callback = self.pendingSensorResult else { return }
        self.pendingSensorResult = nil
        self.clearSensorOperationState()
        self.main { callback(self.error(code: code, message: message)) }
      }
    }
    stopSensorStreamProducerIfUnused()
  }

  private func stopSensorStreamProducerIfUnused() {
    reconfigureSensorStreamProducerIfNeeded()
  }
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
    self.oneShotMotionManager?.stopDeviceMotionUpdates()
    self.oneShotAltimeter?.stopRelativeAltitudeUpdates()
    self.oneShotMotionManager = nil
    self.oneShotAltimeter = nil
    self.streamQueue.sync {
      self.sharedSensorReadGeneration = nil
      self.sensorReadUsesSharedProducer = false
      self.stopSensorStreamProducerIfUnused()
    }
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

  /// Returns a structured denial without starting Core Motion producers.  The
  /// permission service is the only owner allowed to request system access;
  /// `start*Updates` can otherwise trigger an implicit iOS prompt.
  private func sensorPermissionError(
    motionAvailable: Bool,
    altitudeAvailable: Bool
  ) -> [String: Any]? {
    if motionAvailable {
      switch CMMotionActivityManager.authorizationStatus() {
      case .authorized:
        break
      case .denied, .restricted, .notDetermined:
        return error(
          code: "hardware_permission_denied",
          message: "motion and fitness permission is not granted; request it through the permissions service"
        )
      @unknown default:
        return error(
          code: "hardware_permission_denied",
          message: "motion and fitness permission status is unavailable"
        )
      }
    }
    if altitudeAvailable {
      switch CMAltimeter.authorizationStatus() {
      case .authorized:
        break
      case .denied, .restricted, .notDetermined:
        return error(
          code: "hardware_permission_denied",
          message: "barometer permission is not granted; request it through the permissions service"
        )
      @unknown default:
        return error(
          code: "hardware_permission_denied",
          message: "barometer permission status is unavailable"
        )
      }
    }
    return nil
  }

  private func sharedSensorReadValues() -> [String: Any]? {
    streamQueue.sync {
      guard let motion = latestStreamMotion ?? motionManager.deviceMotion else {
        guard let pressure = latestStreamPressureHpa else { return nil }
        var values: [String: Any] = [
          "ok": true,
          "realSensors": true,
          "pressureHpa": pressure,
        ]
        if let altitude = latestStreamRelativeAltitudeM {
          values["relativeAltitudeM"] = altitude
        }
        return values
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
      if let pressure = latestStreamPressureHpa { values["pressureHpa"] = pressure }
      if let altitude = latestStreamRelativeAltitudeM { values["relativeAltitudeM"] = altitude }
      return values
    }
  }

  /// Called on streamQueue after a real producer callback. The completion is
  /// handed to sensorQueue, so a sample callback—not a polling timer—wakes a
  /// shared one-shot read.
  private func wakeSharedSensorReadIfPending() {
    guard let generation = sharedSensorReadGeneration else { return }
    sensorQueue.addOperation { [weak self] in
      self?.completeSharedSensorReadIfReady(generation: generation, timedOut: false)
    }
  }

  private func completeSharedSensorReadIfReady(generation: UInt64, timedOut: Bool) {
    guard sensorGeneration == generation, pendingSensorResult != nil else { return }
    if let values = sharedSensorReadValues() {
      guard let callback = pendingSensorResult else { return }
      pendingSensorResult = nil
      clearSensorOperationState()
      main { callback(values) }
      return
    }
    if timedOut {
      guard let callback = pendingSensorResult else { return }
      pendingSensorResult = nil
      clearSensorOperationState()
      main { callback(self.error(code: "hardware_sensor_timeout", message: "sensor sample was unavailable")) }
    }
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
      let sharedProducerActive = self.streamQueue.sync { self.sensorStreamProducerRunning }
      let timeoutMillis = max(250, min(timeoutMs ?? 750, 30000))
      if sharedProducerActive {
        self.sensorOwnerToken = ownerToken
        self.sensorSessionId = sessionId
        self.sensorOperationId = operationId
        self.pendingSensorResult = result
        self.streamQueue.sync {
          self.sensorReadUsesSharedProducer = true
          self.sharedSensorReadGeneration = generation
          self.reconfigureSensorStreamProducerIfNeeded()
        }
        let timeoutItem = DispatchWorkItem { [weak self] in
          self?.sensorQueue.addOperation {
            self?.completeSharedSensorReadIfReady(generation: generation, timedOut: true)
          }
        }
        self.sensorTimeout = timeoutItem
        DispatchQueue.global(qos: .utility).asyncAfter(
          deadline: .now() + .milliseconds(timeoutMillis),
          execute: timeoutItem
        )
        // Consume an already-published producer sample without waiting for a
        // later callback; future samples still wake through the callback path.
        self.completeSharedSensorReadIfReady(generation: generation, timedOut: false)
        return
      }
      let oneShotMotionManager = CMMotionManager()
      let oneShotAltimeter = CMAltimeter()
      self.oneShotMotionManager = oneShotMotionManager
      self.oneShotAltimeter = oneShotAltimeter
      let motionAvailable = oneShotMotionManager.isDeviceMotionAvailable
      let altitudeAvailable = CMAltimeter.isRelativeAltitudeAvailable()
      guard motionAvailable || altitudeAvailable else {
        self.main { result(self.error(code: "hardware_unsupported", message: "motion and barometer sensors are unavailable")) }
        return
      }
      if let permissionError = self.sensorPermissionError(
        motionAvailable: motionAvailable,
        altitudeAvailable: altitudeAvailable
      ) {
        self.main { result(permissionError) }
        return
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
        guard let sampledMotion = motion ?? oneShotMotionManager.deviceMotion else {
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
      let scheduleSettle: () -> Void = { [weak self] in
        guard !settleScheduled, let self = self, self.sensorGeneration == generation else { return }
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
        oneShotMotionManager.deviceMotionUpdateInterval = 1.0 / 10.0
        oneShotMotionManager.startDeviceMotionUpdates(to: self.sensorQueue) { [weak self] value, error in
          guard let self = self, self.sensorGeneration == generation else { return }
          if let value = value {
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
        oneShotAltimeter.startRelativeAltitudeUpdates(to: self.sensorQueue) { [weak self] value, error in
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
      DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + .milliseconds(250), execute: timeoutItem)
    }
  }

  private func disposeSession(sessionId: String?, sensorOwnerToken: String?, result: @escaping FlutterResult) {
    sensorQueue.addOperation {
      let tokenMatches = sensorOwnerToken == nil || sensorOwnerToken == self.sensorOwnerToken
      let sessionMatches = sessionId == nil || sessionId == self.sensorSessionId
      if tokenMatches && sessionMatches {
        _ = self.supersedeSensorOperationOnQueue(code: "plugin_revoked", message: "sensor session disposed")
      }
      self.streamQueue.async {
        let ids = self.hardwareStreams.values.filter { sessionId == nil || $0.sessionId == sessionId }.map { $0.streamId }
        for id in ids {
          guard self.hardwareStreams.removeValue(forKey: id) != nil else { continue }
          self.clearBufferedHardwareEvents(streamId: id)
          self.emitHardwareDone(streamId: id)
        }
        self.stopSensorStreamProducerIfUnused()
        self.main { result(["ok": true, "disposed": true]) }
      }
    }
  }

  private func main(_ block: @escaping () -> Void) {
    if Thread.isMainThread { block() } else { DispatchQueue.main.async(execute: block) }
  }
  private func error(code: String, message: String) -> [String: Any] { ["ok": false, "errorCode": code, "error": message] }
}

private final class PocketSensorsStreamState {
  let streamId: String
  let kind: String
  let sessionId: String
  let samplingHz: Double
  var ready: Bool
  var startResult: FlutterResult?
  var lastEmissionNs: UInt64 = 0
  init(streamId: String, kind: String, sessionId: String, samplingHz: Double = 10, ready: Bool = false, startResult: FlutterResult? = nil) {
    self.streamId = streamId; self.kind = kind; self.sessionId = sessionId; self.samplingHz = samplingHz
    self.ready = ready; self.startResult = startResult
  }
}
