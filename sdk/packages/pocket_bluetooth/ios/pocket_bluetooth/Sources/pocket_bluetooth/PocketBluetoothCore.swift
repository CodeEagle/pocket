import CoreBluetooth
import Foundation

public typealias PocketBluetoothResult = ([String: Any]) -> Void
public typealias PocketBluetoothEventSink = ([String: Any]) -> Void

public final class PocketBluetoothCore: NSObject, CBCentralManagerDelegate, CBPeripheralDelegate {
  public static let shared = PocketBluetoothCore()
  private var hardwareEventSink: PocketBluetoothEventSink?
  private var bufferedHardwareEvents: [[String: Any]] = []
  private let maxBufferedHardwareEvents = 128
  private let bleQueue = DispatchQueue(label: "com.pocketnexus.host.hardware.bluetooth", qos: .userInitiated)
  private let streamQueue = DispatchQueue(label: "com.pocketnexus.host.hardware.bluetooth.streams", qos: .userInitiated)
  private var central: CBCentralManager?
  // CoreBluetooth reports the initial manager state asynchronously. Keep the
  // state explicit so a first request/scan never treats `.unknown` as
  // powered-on (or as a permission denial).
  private var centralState: CBManagerState = .unknown
  private var centralStateGeneration: UInt64 = 0
  private var discovered: [String: CBPeripheral] = [:]
  private var discoveredInfo: [String: [String: Any]] = [:]
  private var pendingScanResult: PocketBluetoothResult?
  private var pendingScanSessionId: String?
  private var scanGeneration: UInt64 = 0
  private var scanTimeout: DispatchWorkItem?
  private var pendingConnections: [String: PocketBluetoothResult] = [:]
  private var pendingConnectionSessions: [String: String] = [:]
  private var pendingConnectionPeripherals: [String: CBPeripheral] = [:]
  private var connectionTimeouts: [String: DispatchWorkItem] = [:]
  private var connectedSessionByDevice: [String: String] = [:]
  private var pendingGattOperations: [String: PocketBluetoothGattOperation] = [:]
  private var queuedGattOperations: [String: [PocketBluetoothGattOperation]] = [:]
  private var activeGattOperationByDevice: [String: String] = [:]
  private var nextGattOperationId: UInt64 = 0
  private var hardwareStreams: [String: PocketBluetoothStreamState] = [:]
  private var notificationStates: [String: PocketBluetoothNotificationState] = [:]
  private var pendingPermissionResult: PocketBluetoothResult?
  private var pendingPermissionSessionId: String?
  private var permissionGeneration: UInt64 = 0
  private var permissionTimeout: DispatchWorkItem?

  private override init() { super.init() }

  public func setEventSink(_ sink: PocketBluetoothEventSink?) {
    main {
      self.hardwareEventSink = sink
      guard let sink else { return }
      let buffered = self.bufferedHardwareEvents
      self.bufferedHardwareEvents.removeAll(keepingCapacity: true)
      for packet in buffered { sink(packet) }
    }
  }

  public func handle(method: String, args: [String: Any] = [:], result: @escaping PocketBluetoothResult) {
    switch method {
    case "requestBlePermission":
      requestBlePermission(
        timeoutMs: args["timeoutMs"] as? Int ?? 10000,
        sessionId: args["sessionId"] as? String,
        result: result
      )
    case "startBleScan":
      let timeout = args["timeoutMs"] as? Int ?? 1600
      startBleScan(timeoutMs: max(250, min(timeout, 30000)), sessionId: args["sessionId"] as? String, result: result)
    case "connectBleDevice":
      connectBleDevice(id: args["deviceId"] as? String ?? "", sessionId: args["sessionId"] as? String, result: result)
    case "readBleCharacteristic":
      readBleCharacteristic(deviceId: args["deviceId"] as? String ?? "", serviceUuid: args["serviceUuid"] as? String ?? "", characteristicUuid: args["characteristicUuid"] as? String ?? "", sessionId: args["sessionId"] as? String, result: result)
    case "writeBleCharacteristic":
      writeBleCharacteristic(deviceId: args["deviceId"] as? String ?? "", serviceUuid: args["serviceUuid"] as? String ?? "", characteristicUuid: args["characteristicUuid"] as? String ?? "", value: args["value"] as? [Any] ?? [], withResponse: args["withResponse"] as? Bool ?? true, sessionId: args["sessionId"] as? String, result: result)
    case "startHardwareStream":
      startHardwareStream(streamId: args["streamId"] as? String ?? "", sessionId: args["sessionId"] as? String, args: args, result: result)
    case "stopHardwareStream":
      stopHardwareStream(streamId: args["streamId"] as? String ?? "", sessionId: args["sessionId"] as? String, result: result)
    case "disposeSession":
      disposeSession(sessionId: args["sessionId"] as? String, result: result)
    default:
      result(error(code: "hardware_unsupported", message: "unknown Bluetooth method: \(method)"))
    }
  }

  public func dispose(result: @escaping PocketBluetoothResult = { _ in }) {
    disposeSession(sessionId: nil, result: result)
  }

  private func requestBlePermission(
    timeoutMs: Int,
    sessionId: String?,
    result: @escaping PocketBluetoothResult
  ) {
    bleQueue.async {
      let boundedTimeout = max(500, min(timeoutMs, 30000))
      switch CBCentralManager.authorization {
      case .denied, .restricted:
        self.main { result(self.error(code: "hardware_permission_denied", message: "Bluetooth permission is denied for this app")) }
        return
      case .allowedAlways, .notDetermined:
        // Creating CBCentralManager is what causes CoreBluetooth to settle its
        // authorization/state on macOS. Even when authorization is already
        // granted, wait for that asynchronous initialization before replying.
        break
      @unknown default:
        self.main { result(self.error(code: "hardware_bluetooth_unavailable", message: "Bluetooth authorization state is unknown")) }
        return
      }
      guard self.pendingPermissionResult == nil else {
        self.main { result(self.error(code: "hardware_busy", message: "Bluetooth permission request is already running")) }
        return
      }
      self.pendingPermissionResult = result
      self.pendingPermissionSessionId = sessionId
      self.permissionGeneration &+= 1
      let generation = self.permissionGeneration
      self.permissionTimeout?.cancel()
      let timeout = DispatchWorkItem {
        guard self.permissionGeneration == generation,
              self.pendingPermissionResult != nil else { return }
        self.pendingPermissionResult = nil
        self.pendingPermissionSessionId = nil
        self.permissionTimeout = nil
        self.main { result(self.error(code: "hardware_timeout", message: "Timed out waiting for Bluetooth permission")) }
      }
      self.permissionTimeout = timeout
      guard self.ensureCentral(allowNotDetermined: true) else {
        self.pendingPermissionResult = nil
        self.pendingPermissionSessionId = nil
        self.permissionTimeout?.cancel()
        self.permissionTimeout = nil
        self.main { result(self.error(code: "hardware_permission_denied", message: "Bluetooth permission is not granted for this app")) }
        return
      }
      self.bleQueue.asyncAfter(deadline: .now() + .milliseconds(boundedTimeout), execute: timeout)
      let deadline = DispatchTime.now() + .milliseconds(boundedTimeout)
      self.waitForPermissionState(deadline: deadline, generation: generation)
    }
  }

  private func finishPermission(_ value: [String: Any]) {
    permissionGeneration &+= 1
    permissionTimeout?.cancel()
    permissionTimeout = nil
    guard let callback = pendingPermissionResult else { return }
    pendingPermissionResult = nil
    pendingPermissionSessionId = nil
    main { callback(value) }
  }

  private func waitForPermissionState(deadline: DispatchTime, generation: UInt64) {
    guard permissionGeneration == generation, pendingPermissionResult != nil else { return }
    waitForCentralState(until: deadline) { state in
      guard self.permissionGeneration == generation, self.pendingPermissionResult != nil else { return }
      let authorization = CBCentralManager.authorization
      switch authorization {
      case .allowedAlways:
        switch state {
        case .unsupported:
          self.finishPermission(self.error(code: "hardware_unsupported", message: "Bluetooth is unsupported on this Mac"))
        case .unauthorized:
          self.finishPermission(self.error(code: "hardware_bluetooth_unavailable", message: "Bluetooth is unavailable for this Mac"))
        case .unknown, .resetting:
          self.waitForPermissionState(deadline: deadline, generation: generation)
        default:
          // Permission is an OS authorization. Bluetooth being powered off is
          // a separate availability condition and must not make permission
          // requests time out or report denied.
          self.finishPermission([
            "ok": true,
            "permission": "hardware.bluetooth",
            "status": "granted",
            "granted": true,
            "realHardware": true,
          ])
        }
      case .denied, .restricted:
        self.finishPermission(self.error(code: "hardware_permission_denied", message: "Bluetooth permission was denied for this app"))
      case .notDetermined:
        if state == .unsupported {
          self.finishPermission(self.error(code: "hardware_unsupported", message: "Bluetooth is unsupported on this Mac"))
        } else {
          self.waitForPermissionState(deadline: deadline, generation: generation)
        }
      @unknown default:
        self.finishPermission(self.error(code: "hardware_bluetooth_unavailable", message: "Bluetooth authorization state is unknown"))
      }
    }
  }

  private func startHardwareStream(streamId: String, sessionId: String?, args: [String: Any], result: @escaping PocketBluetoothResult) {
    guard !streamId.isEmpty, let sessionId = sessionId, !sessionId.isEmpty else {
      result(error(code: "invalid_argument", message: "streamId and sessionId are required")); return
    }
    guard CBCentralManager.authorization == .allowedAlways else {
      result(error(code: "hardware_permission_denied", message: "Bluetooth permission is not granted; request it through the permissions service")); return
    }
    guard let deviceId = args["deviceId"] as? String, !deviceId.isEmpty,
          let serviceUuid = args["serviceUuid"] as? String, !serviceUuid.isEmpty,
          let characteristicUuid = args["characteristicUuid"] as? String, !characteristicUuid.isEmpty else {
      result(error(code: "invalid_argument", message: "deviceId, serviceUuid, and characteristicUuid are required")); return
    }
    streamQueue.async {
      guard self.hardwareStreams[streamId] == nil else {
        self.main { result(self.error(code: "hardware_stream_exists", message: "hardware stream id is already active")) }; return
      }
      self.hardwareStreams[streamId] = PocketBluetoothStreamState(streamId: streamId, kind: "ble.notifications", sessionId: sessionId, deviceId: deviceId, serviceUuid: serviceUuid, characteristicUuid: characteristicUuid, startResult: result)
      self.bleQueue.async {
        self.prepareNotificationStream(streamId: streamId, sessionId: sessionId, deviceId: deviceId, serviceUuid: serviceUuid, characteristicUuid: characteristicUuid)
      }
    }
  }

  private func stopHardwareStream(streamId: String, sessionId: String?, result: @escaping PocketBluetoothResult) {
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
      if let deviceId = state.deviceId, let serviceUuid = state.serviceUuid, let characteristicUuid = state.characteristicUuid {
        self.bleQueue.async { self.cancelNotificationStream(streamId: streamId, deviceId: deviceId, serviceUuid: serviceUuid, characteristicUuid: characteristicUuid) }
      }
      let pendingStart = state.startResult
      state.startResult = nil
      self.clearBufferedHardwareEvents(streamId: streamId)
      self.emitHardwareDone(streamId: streamId)
      if let pendingStart = pendingStart { self.main { pendingStart(self.error(code: "hardware_cancelled", message: "hardware stream was stopped before it started")) } }
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
    guard CBCentralManager.authorization == .allowedAlways else {
      failHardwareStream(
        streamId: streamId,
        sessionId: sessionId,
        code: "hardware_permission_denied",
        message: "Bluetooth permission is no longer granted"
      )
      return
    }
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
      let value = PocketBluetoothNotificationState(
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
    state: PocketBluetoothNotificationState,
    enable: Bool
  ) {
    let operation = PocketBluetoothGattOperation(
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
    state: PocketBluetoothNotificationState,
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
  private func ensureCentral(allowNotDetermined: Bool = false) -> Bool {
    let authorization = CBCentralManager.authorization
    guard authorization == .allowedAlways || (allowNotDetermined && authorization == .notDetermined) else { return false }
    if central == nil {
      centralState = .unknown
      central = CBCentralManager(delegate: self, queue: bleQueue)
    } else {
      centralState = central?.state ?? .unknown
    }
    return true
  }

  /// Wait for the asynchronous first CBCentralManager delegate update. A
  /// powered-off adapter is a settled state and is returned to the caller so
  /// it can be reported as unavailable; `.unknown`/`.resetting` are not.
  private func waitForCentralState(until deadline: DispatchTime, completion: @escaping (CBManagerState) -> Void) {
    let generation = centralStateGeneration
    func poll() {
      guard self.centralStateGeneration == generation else {
        completion(.unknown)
        return
      }
      let state = self.central?.state ?? self.centralState
      if state != .unknown && state != .resetting {
        completion(state)
        return
      }
      if DispatchTime.now().uptimeNanoseconds >= deadline.uptimeNanoseconds {
        completion(.unknown)
        return
      }
      self.bleQueue.asyncAfter(deadline: .now() + .milliseconds(50)) {
        poll()
      }
    }
    poll()
  }

  private func startBleScan(
    timeoutMs: Int,
    sessionId: String?,
    result: @escaping PocketBluetoothResult
  ) {
    bleQueue.async {
      guard self.ensureCentral() else {
        self.main {
          result(self.error(
            code: "hardware_permission_denied",
            message: "Bluetooth permission is not granted; request it through the permissions service"
          ))
        }
        return
      }
      guard self.central != nil else {
        self.main { result(self.error(code: "hardware_unsupported", message: "Bluetooth manager is unavailable")) }
        return
      }
      guard self.pendingScanResult == nil else {
        self.main { result(self.error(code: "hardware_busy", message: "Bluetooth scan is already running")) }
        return
      }
      // Reserve the result slot before waiting for the initial state so a
      // session dispose can revoke this operation without leaving the caller
      // hanging. No scan starts until the actual delegate state is poweredOn.
      self.pendingScanResult = result
      self.pendingScanSessionId = sessionId
      self.waitForCentralState(until: .now() + .milliseconds(max(500, min(timeoutMs, 10000)))) { state in
        guard self.pendingScanResult != nil else { return }
        guard state == .poweredOn, let central = self.central else {
          let code: String
          switch state {
          case .unauthorized: code = "hardware_permission_denied"
          case .unsupported: code = "hardware_unsupported"
          default: code = "hardware_bluetooth_unavailable"
          }
          self.scanGeneration &+= 1
          self.pendingScanResult = nil
          self.pendingScanSessionId = nil
          self.main { result(self.error(code: code, message: "Bluetooth is not powered on")) }
          return
        }
        self.discovered.removeAll()
        self.discoveredInfo.removeAll()
        self.scanGeneration &+= 1
        let generation = self.scanGeneration
        central.scanForPeripherals(withServices: nil, options: [CBCentralManagerScanOptionAllowDuplicatesKey: false])
        let timeout = DispatchWorkItem { self.finishBleScan(generation: generation) }
        self.scanTimeout = timeout
        self.bleQueue.asyncAfter(deadline: .now() + .milliseconds(timeoutMs), execute: timeout)
      }
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
    result: @escaping PocketBluetoothResult
  ) {
    guard !id.isEmpty else {
      result(error(code: "invalid_argument", message: "deviceId must not be empty"))
      return
    }
    bleQueue.async {
      guard self.ensureCentral() else {
        self.main {
          result(self.error(
            code: "hardware_permission_denied",
            message: "Bluetooth permission is not granted; request it through the permissions service"
          ))
        }
        return
      }
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

  public func centralManagerDidUpdateState(_ central: CBCentralManager) {
    centralState = central.state
    if (central.state == .poweredOn || central.state == .poweredOff),
       CBCentralManager.authorization == .allowedAlways,
       pendingPermissionResult != nil {
      // The permission result is independent from adapter availability. In
      // particular, poweredOff still means the user granted this app access.
      finishPermission(["ok": true, "permission": "hardware.bluetooth", "status": "granted", "granted": true, "realHardware": true])
    } else if central.state == .unauthorized || CBCentralManager.authorization == .denied || CBCentralManager.authorization == .restricted {
      if pendingPermissionResult != nil {
        finishPermission(error(code: "hardware_permission_denied", message: "Bluetooth permission was denied for this app"))
      }
    } else if central.state == .unsupported {
      if pendingPermissionResult != nil {
        finishPermission(error(code: "hardware_unsupported", message: "Bluetooth is unsupported on this Mac"))
      }
    }
    // A pending scan is completed with a structured error if Bluetooth turns
    // off while it is running (or while it is waiting for the first state);
    // unknown/resetting must remain pending until the delegate settles.
    guard central.state == .poweredOff || central.state == .unauthorized || central.state == .unsupported else { return }
    let code: String
    switch central.state {
    case .unauthorized: code = "hardware_permission_denied"
    case .unsupported: code = "hardware_unsupported"
    default: code = "hardware_bluetooth_unavailable"
    }
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

  public func centralManager(
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

  public func centralManager(_ central: CBCentralManager, didConnect peripheral: CBPeripheral) {
    let id = peripheral.identifier.uuidString
    guard pendingConnectionPeripherals[id] === peripheral else {
      peripheral.delegate = nil
      return
    }
    peripheral.delegate = self
    peripheral.discoverServices(nil)
  }

  public func centralManager(_ central: CBCentralManager, didFailToConnect peripheral: CBPeripheral, error: Error?) {
    let id = peripheral.identifier.uuidString
    guard pendingConnectionPeripherals[id] === peripheral else {
      peripheral.delegate = nil
      return
    }
    finishConnection(id: id, value: self.error(code: "hardware_bluetooth_connect", message: error?.localizedDescription ?? "Bluetooth connection failed"))
  }

  public func centralManager(_ central: CBCentralManager, didDisconnectPeripheral peripheral: CBPeripheral, error: Error?) {
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

  public func peripheral(_ peripheral: CBPeripheral, didDiscoverServices error: Error?) {
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

  public func peripheral(
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

  private func enqueueGattOperation(_ operation: PocketBluetoothGattOperation) {
    let deviceId = operation.deviceId
    if activeGattOperationByDevice[deviceId] != nil {
      queuedGattOperations[deviceId, default: []].append(operation)
      return
    }
    startGattOperation(operation)
  }

  private func startGattOperation(_ operation: PocketBluetoothGattOperation) {
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
    kind: PocketBluetoothGattOperationKind
  ) -> PocketBluetoothGattOperation? {
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
    var operations: [PocketBluetoothGattOperation] = []
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
    result: @escaping PocketBluetoothResult
  ) {
    guard !deviceId.isEmpty, !serviceUuid.isEmpty, !characteristicUuid.isEmpty,
          let sessionId = sessionId, !sessionId.isEmpty else {
      result(error(code: "invalid_argument", message: "deviceId, serviceUuid, characteristicUuid, and sessionId are required"))
      return
    }
    guard CBCentralManager.authorization == .allowedAlways else {
      result(error(
        code: "hardware_permission_denied",
        message: "Bluetooth permission is not granted; request it through the permissions service"
      ))
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
      let operation = PocketBluetoothGattOperation(
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
    result: @escaping PocketBluetoothResult
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
    guard CBCentralManager.authorization == .allowedAlways else {
      result(error(
        code: "hardware_permission_denied",
        message: "Bluetooth permission is not granted; request it through the permissions service"
      ))
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
        let operation = PocketBluetoothGattOperation(
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
        let operation = PocketBluetoothGattOperation(
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

  public func peripheral(
    _ peripheral: CBPeripheral,
    didUpdateValueFor characteristic: CBCharacteristic,
    error: Error?
  ) {
    let deviceId = peripheral.identifier.uuidString
    let serviceUuid = characteristic.service?.uuid.uuidString ?? ""
    let characteristicUuid = characteristic.uuid.uuidString
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

  public func peripheral(
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

  public func peripheral(
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
  private func disposeSession(sessionId: String?, result: @escaping PocketBluetoothResult) {
    bleQueue.async {
      let ownsPermission = sessionId == nil || self.pendingPermissionSessionId == sessionId
      if ownsPermission, let callback = self.pendingPermissionResult {
        self.pendingPermissionResult = nil
        self.pendingPermissionSessionId = nil
        self.permissionGeneration &+= 1
        self.permissionTimeout?.cancel()
        self.permissionTimeout = nil
        self.main { callback(self.error(code: "plugin_revoked", message: "Bluetooth session disposed")) }
      }
      if sessionId == nil {
        // Invalidate state waits before clearing the manager. Their callbacks
        // will observe the generation change and cannot resurrect a scan or
        // permission request after teardown.
        self.centralStateGeneration &+= 1
      }
      let ownsScan = sessionId == nil || self.pendingScanSessionId == sessionId
      if ownsScan {
        self.scanGeneration &+= 1
        self.central?.stopScan()
        self.scanTimeout?.cancel()
        self.scanTimeout = nil
        self.pendingScanSessionId = nil
        if let callback = self.pendingScanResult {
          self.pendingScanResult = nil
          self.main { callback(self.error(code: "plugin_revoked", message: "Bluetooth session disposed")) }
        }
      }
      let pending = self.pendingConnections.filter { id, _ in sessionId == nil || self.pendingConnectionSessions[id] == sessionId }
      for (id, callback) in pending {
        if let peripheral = self.discovered[id] {
          peripheral.delegate = nil
          self.central?.cancelPeripheralConnection(peripheral)
        }
        self.main { callback(self.error(code: "plugin_revoked", message: "Bluetooth session disposed")) }
        self.pendingConnectionSessions.removeValue(forKey: id)
        self.pendingConnectionPeripherals.removeValue(forKey: id)
        self.connectionTimeouts[id]?.cancel()
        self.connectionTimeouts.removeValue(forKey: id)
        self.pendingConnections.removeValue(forKey: id)
      }
      var ownedDeviceIds = Set(self.connectedSessionByDevice.compactMap { id, owner in (sessionId == nil || owner == sessionId) ? id : nil })
      for (deviceId, operationId) in self.activeGattOperationByDevice {
        if let operation = self.pendingGattOperations[operationId], sessionId == nil || operation.sessionId == sessionId { ownedDeviceIds.insert(deviceId) }
      }
      for (deviceId, operations) in self.queuedGattOperations {
        if operations.contains(where: { sessionId == nil || $0.sessionId == sessionId }) { ownedDeviceIds.insert(deviceId) }
      }
      for deviceId in ownedDeviceIds {
        self.abortGattDevice(deviceId: deviceId, code: "plugin_revoked", message: "Bluetooth session disposed")
      }
      self.streamQueue.async {
        let ids = self.hardwareStreams.values.filter { sessionId == nil || $0.sessionId == sessionId }.map { $0.streamId }
        for id in ids {
          guard let state = self.hardwareStreams.removeValue(forKey: id) else { continue }
          if let deviceId = state.deviceId, let serviceUuid = state.serviceUuid, let characteristicUuid = state.characteristicUuid {
            self.cancelNotificationStream(streamId: id, deviceId: deviceId, serviceUuid: serviceUuid, characteristicUuid: characteristicUuid)
          }
          let pendingStart = state.startResult
          state.startResult = nil
          self.clearBufferedHardwareEvents(streamId: id)
          self.emitHardwareDone(streamId: id)
          if let pendingStart = pendingStart { self.main { pendingStart(self.error(code: "plugin_revoked", message: "Bluetooth session disposed")) } }
        }
        if sessionId == nil {
          // A global dispose is the helper/plugin lifecycle boundary. Detach
          // the delegate before releasing the manager and discard all
          // discovered/connection/GATT ownership caches so a later helper
          // instance starts from a clean CoreBluetooth state.
          self.central?.stopScan()
          self.central?.delegate = nil
          self.central = nil
          self.centralState = .unknown
          self.discovered.removeAll()
          self.discoveredInfo.removeAll()
          self.connectedSessionByDevice.removeAll()
          self.pendingConnections.removeAll()
          self.pendingConnectionSessions.removeAll()
          self.pendingConnectionPeripherals.removeAll()
          self.connectionTimeouts.values.forEach { $0.cancel() }
          self.connectionTimeouts.removeAll()
          self.pendingGattOperations.values.forEach { $0.timeout?.cancel() }
          self.pendingGattOperations.removeAll()
          self.queuedGattOperations.removeAll()
          self.activeGattOperationByDevice.removeAll()
          self.notificationStates.removeAll()
          self.bufferedHardwareEvents.removeAll()
        }
        self.main { result(["ok": true, "disposed": true]) }
      }
    }
  }

  // MARK: - Helpers

  private func main(_ block: @escaping () -> Void) {
    if Thread.isMainThread { block() } else { DispatchQueue.main.async(execute: block) }
  }

  private func error(code: String, message: String) -> [String: Any] {
    ["ok": false, "errorCode": code, "error": message]
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

private final class PocketBluetoothStreamState {
  let streamId: String
  let kind: String
  let sessionId: String
  let samplingHz: Double
  let deviceId: String?
  let serviceUuid: String?
  let characteristicUuid: String?
  var ready: Bool
  var characteristic: CBCharacteristic?
  var startResult: PocketBluetoothResult?
  var lastEmissionNs: UInt64 = 0

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
    startResult: PocketBluetoothResult? = nil
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

private enum PocketBluetoothGattOperationKind: Equatable {
  case read
  case write
  case writeWithoutResponse
  case cccdEnable
  case cccdDisable
}

private final class PocketBluetoothNotificationState {
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

private final class PocketBluetoothGattOperation {
  let deviceId: String
  let key: String
  let id: String
  let kind: PocketBluetoothGattOperationKind
  let peripheral: CBPeripheral
  let characteristic: CBCharacteristic
  let serviceUuid: String
  let characteristicUuid: String
  let sessionId: String
  let result: PocketBluetoothResult?
  let start: () -> Void
  let completion: (([String: Any]) -> Void)?
  let immediateResult: [String: Any]?
  var timeout: DispatchWorkItem?
  let byteCount: Int

  init(
    deviceId: String,
    key: String,
    id: String,
    kind: PocketBluetoothGattOperationKind,
    peripheral: CBPeripheral,
    characteristic: CBCharacteristic,
    serviceUuid: String,
    characteristicUuid: String,
    sessionId: String,
    result: PocketBluetoothResult?,
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

}
