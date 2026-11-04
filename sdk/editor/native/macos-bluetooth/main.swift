import CoreBluetooth
import Darwin
import Foundation

private let core = PocketBluetoothCore.shared
private let outputLock = NSLock()
private let shutdownLock = NSLock()
private var shuttingDown = false
private var exited = false

private func writePacket(_ packet: [String: Any]) {
  guard JSONSerialization.isValidJSONObject(packet),
        let data = try? JSONSerialization.data(withJSONObject: packet, options: []) else {
    return
  }
  outputLock.lock()
  defer { outputLock.unlock() }
  FileHandle.standardOutput.write(data)
  FileHandle.standardOutput.write(Data([0x0a]))
}

private func reply(id: String, result: [String: Any]) {
  writePacket(["id": id, "result": result])
}

private func finishShutdown() {
  shutdownLock.lock()
  guard !exited else {
    shutdownLock.unlock()
    return
  }
  exited = true
  shutdownLock.unlock()
  exit(EXIT_SUCCESS)
}

private func beginShutdown() {
  shutdownLock.lock()
  guard !shuttingDown else {
    shutdownLock.unlock()
    return
  }
  shuttingDown = true
  shutdownLock.unlock()

  // CoreBluetooth teardown is serialized with its delegate queue. Give it a
  // bounded grace period, then exit even if a peripheral callback is stuck.
  core.dispose { _ in
    DispatchQueue.main.async { finishShutdown() }
  }
  DispatchQueue.main.asyncAfter(deadline: .now() + .seconds(3)) {
    finishShutdown()
  }
}

signal(SIGTERM, SIG_IGN)
signal(SIGINT, SIG_IGN)
let termSignal = DispatchSource.makeSignalSource(signal: SIGTERM, queue: DispatchQueue.global(qos: .utility))
termSignal.setEventHandler { beginShutdown() }
termSignal.resume()
let intSignal = DispatchSource.makeSignalSource(signal: SIGINT, queue: DispatchQueue.global(qos: .utility))
intSignal.setEventHandler { beginShutdown() }
intSignal.resume()

core.setEventSink { packet in
  writePacket(["event": packet])
}

DispatchQueue.global(qos: .userInitiated).async {
  while let line = readLine(strippingNewline: true) {
    shutdownLock.lock()
    let stopping = shuttingDown
    shutdownLock.unlock()
    if stopping { break }
    guard !line.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
          let data = line.data(using: .utf8),
          let request = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else {
      writePacket(["event": ["type": "error", "error": ["code": "invalid_argument", "message": "invalid JSON request"]]])
      continue
    }
    let id = request["id"] as? String ?? UUID().uuidString
    let method = request["method"] as? String ?? ""
    let params = request["params"] as? [String: Any] ?? [:]
    guard !method.isEmpty else {
      reply(id: id, result: ["ok": false, "errorCode": "invalid_argument", "error": "method is required"])
      continue
    }
    core.handle(method: method, args: params) { result in
      reply(id: id, result: result)
    }
  }
  beginShutdown()
}

RunLoop.main.run()
