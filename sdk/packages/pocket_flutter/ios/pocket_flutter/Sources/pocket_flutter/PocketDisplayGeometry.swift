import Flutter
import UIKit

/// Bridges iOS 27.1 ReservedRegion geometry to the JS-owned display contract.
///
/// The bridge never infers a device model or reads UIScreen. UIKit supplies
/// frames in the Flutter view's own logical coordinate space. The Dart
/// PocketView then clips and transforms those frames into the guest canvas.
final class PocketDisplayGeometry: NSObject {
  static let shared = PocketDisplayGeometry()

  private static let channelName = "com.pocketnexus.host/displayGeometry"

  private var channel: FlutterMethodChannel?
  private var activeClients = 0
  private weak var flutterView: UIView?
  private weak var probeView: PocketDisplayGeometryProbeView?
  private var hingeInteraction: UIInteraction?
  private var observers: [NSObjectProtocol] = []
  private var lastSignature: String?

  private override init() {
    super.init()
  }

  func attach(registrar: FlutterPluginRegistrar) {
    if channel != nil { return }
    let methodChannel = FlutterMethodChannel(
      name: Self.channelName,
      binaryMessenger: registrar.messenger()
    )
    channel = methodChannel
    methodChannel.setMethodCallHandler { [weak self] call, result in
      DispatchQueue.main.async {
        self?.handle(call, result: result)
      }
    }
  }

  private func handle(_ call: FlutterMethodCall, result: @escaping FlutterResult) {
    switch call.method {
    case "start":
      activeClients += 1
      installMonitorIfNeeded()
      let payload = currentSnapshot()
      lastSignature = signature(for: payload)
      result(payload)
    case "stop":
      activeClients = max(0, activeClients - 1)
      if activeClients == 0 { tearDownMonitor() }
      result(nil)
    default:
      result(FlutterMethodNotImplemented)
    }
  }

  private func installMonitorIfNeeded() {
    guard activeClients > 0 else { return }
    guard let root = findFlutterView() else {
      installObservers()
      return
    }
    if flutterView === root {
      installObservers()
      return
    }

    tearDownViewOnly()
    flutterView = root
    let probe = PocketDisplayGeometryProbeView(frame: root.bounds)
    probe.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    probe.backgroundColor = .clear
    probe.isOpaque = false
    probe.isUserInteractionEnabled = false
    probe.isAccessibilityElement = false
    probe.accessibilityElementsHidden = true
    probe.onLayout = { [weak self] in
      self?.publishCurrentSnapshot()
    }
    root.addSubview(probe)
    probeView = probe

    if #available(iOS 27.1, *) {
      let interaction = UIHingeInteraction { [weak self] _, _ in
        // UIKit's reserved-region value can settle after the hinge callback;
        // the next layout/scene callback performs the authoritative read.
        DispatchQueue.main.async {
          self?.flutterView?.setNeedsLayout()
          self?.publishCurrentSnapshot()
        }
      }
      root.addInteraction(interaction)
      hingeInteraction = interaction
    }
    installObservers()
    publishCurrentSnapshot()
  }

  private func installObservers() {
    if !observers.isEmpty { return }
    let center = NotificationCenter.default
    observers = [
      center.addObserver(
        forName: UIApplication.didBecomeActiveNotification,
        object: nil,
        queue: .main
      ) { [weak self] _ in self?.publishCurrentSnapshot() },
      center.addObserver(
        forName: UIWindow.didBecomeKeyNotification,
        object: nil,
        queue: .main
      ) { [weak self] _ in self?.publishCurrentSnapshot() },
      center.addObserver(
        forName: UIScene.didActivateNotification,
        object: nil,
        queue: .main
      ) { [weak self] _ in self?.publishCurrentSnapshot() },
      center.addObserver(
        forName: UIAccessibility.reduceTransparencyStatusDidChangeNotification,
        object: nil,
        queue: .main
      ) { [weak self] _ in self?.publishCurrentSnapshot() },
    ]
  }

  private func publishCurrentSnapshot() {
    guard activeClients > 0 else { return }
    installMonitorIfNeeded()
    let payload = currentSnapshot()
    let nextSignature = signature(for: payload)
    guard nextSignature != lastSignature else { return }
    lastSignature = nextSignature
    channel?.invokeMethod("update", arguments: payload)
  }

  private func currentSnapshot() -> [String: Any] {
    guard let root = flutterView ?? findFlutterView() else {
      return [
        "supported": false,
        "viewport": ["width": 0.0, "height": 0.0],
        "reservedRegions": [[String: Any]](),
        "reduceTransparency": UIAccessibility.isReduceTransparencyEnabled,
      ]
    }
    return snapshot(for: root)
  }

  private func snapshot(for root: UIView) -> [String: Any] {
    var supported = false
    var regions = [[String: Any]]()
    if #available(iOS 27.1, *) {
      supported = true
      regions.append(contentsOf: root.reservedRegions(
        kind: .division,
        options: [.includeInactive]
      ).enumerated().map { index, region in
        encodeRegion(region, kind: "division", index: index)
      })
      regions.append(contentsOf: root.reservedRegions(
        kind: .occlusion,
        options: [.includeInactive]
      ).enumerated().map { index, region in
        encodeRegion(region, kind: "occlusion", index: index)
      })
    }
    return [
      "supported": supported,
      "viewport": [
        "width": max(0.0, root.bounds.width),
        "height": max(0.0, root.bounds.height),
      ],
      "reservedRegions": regions,
      // UIKit exposes this preference globally, independently of whether the
      // optional iOS 27 ReservedRegion API is available.
      "reduceTransparency": UIAccessibility.isReduceTransparencyEnabled,
    ]
  }

  @available(iOS 27.1, *)
  private func encodeRegion(
    _ region: UIView.ReservedRegion,
    kind: String,
    index: Int
  ) -> [String: Any] {
    let frame = region.frame
    let margins = region.margins
    return [
      // UIKit's public description is currently `ID()` for these opaque
      // identifiers. HashValue is stable for this process and is combined
      // with kind/index so JS can key updates without collisions.
      "id": "\(kind)-\(region.id.hashValue)-\(index)",
      "kind": kind,
      "left": frame.minX,
      "top": frame.minY,
      "width": max(0.0, frame.width),
      "height": max(0.0, frame.height),
      "margins": [
        "top": max(0.0, margins.top),
        "right": max(0.0, margins.right),
        "bottom": max(0.0, margins.bottom),
        "left": max(0.0, margins.left),
      ],
      "active": region.isActive,
    ]
  }

  private func signature(for payload: [String: Any]) -> String {
    let viewport = payload["viewport"] as? [String: Any] ?? [:]
    var values = [
      String(describing: viewport["width"] ?? 0),
      String(describing: viewport["height"] ?? 0),
    ]
    let regions = payload["reservedRegions"] as? [[String: Any]] ?? []
    for region in regions {
      values.append(String(describing: region["id"] ?? ""))
      values.append(String(describing: region["kind"] ?? ""))
      values.append(String(describing: region["left"] ?? 0))
      values.append(String(describing: region["top"] ?? 0))
      values.append(String(describing: region["width"] ?? 0))
      values.append(String(describing: region["height"] ?? 0))
      values.append(String(describing: region["margins"] ?? [:]))
      values.append(String(describing: region["active"] ?? false))
    }
    values.append(String(describing: payload["reduceTransparency"] ?? "unknown"))
    return values.joined(separator: "|")
  }

  private func findFlutterView() -> UIView? {
    let scenes = UIApplication.shared.connectedScenes.compactMap {
      $0 as? UIWindowScene
    }
    for scene in scenes where scene.activationState != .unattached {
      let windows = scene.windows.sorted { lhs, rhs in
        lhs.isKeyWindow && !rhs.isKeyWindow
      }
      for window in windows {
        if let controller = findFlutterViewController(window.rootViewController) {
          return controller.viewIfLoaded ?? controller.view
        }
      }
    }
    return nil
  }

  private func findFlutterViewController(
    _ controller: UIViewController?
  ) -> FlutterViewController? {
    guard let controller else { return nil }
    if let flutter = controller as? FlutterViewController { return flutter }
    if let presented = controller.presentedViewController,
       let flutter = findFlutterViewController(presented) {
      return flutter
    }
    for child in controller.children.reversed() {
      if let flutter = findFlutterViewController(child) { return flutter }
    }
    return nil
  }

  private func tearDownMonitor() {
    for observer in observers {
      NotificationCenter.default.removeObserver(observer)
    }
    observers.removeAll()
    tearDownViewOnly()
    lastSignature = nil
  }

  private func tearDownViewOnly() {
    if let interaction = hingeInteraction, let view = flutterView {
      view.removeInteraction(interaction)
    }
    hingeInteraction = nil
    probeView?.removeFromSuperview()
    probeView = nil
    flutterView = nil
  }
}

private final class PocketDisplayGeometryProbeView: UIView {
  var onLayout: (() -> Void)?

  override func layoutSubviews() {
    super.layoutSubviews()
    onLayout?()
  }
}
