import Flutter
import Foundation

/// Native half of the opt-in links provider.
///
/// This plugin does not register a URL scheme or edit the consumer's
/// Info.plist. The trusted consumer owns its URL declaration and forwards
/// cold/warm SceneDelegate URL contexts to `handleIncomingURL`.
public final class PocketPlatformPlugin: NSObject, FlutterPlugin {
  private static var shared: PocketPlatformPlugin?
  // SceneDelegate can deliver connectionOptions before Flutter has finished
  // registering plugins. Keep at most the old manager's initial/latest pair
  // until the plugin instance is attached; static metadata is checked before
  // anything is retained, so installing the package alone still has no URL
  // collection side effect.
  private static var preconfigurationURLs: [String] = []

  private var channel: FlutterMethodChannel?
  private var linksEnabled = false
  private var configuredScheme: String?
  private var initialLink: String?
  private var latestLink: String?
  private struct RecentURL {
    let value: String
    let atUptime: TimeInterval
  }

  private var recentURLs: [RecentURL] = []
  private let deepLinkDedupeWindow: TimeInterval = 0.25
  private let maxRecentURLs = 32
  // A trusted static opt-in may deliver a cold SceneDelegate URL before the
  // Dart isolate has activated the provider. This one-shot preconfiguration
  // window is closed by disable/dispose; without static metadata receive()
  // drops the URL and never creates a cache.
  private var preconfigurationCaptureOpen = true

  public static func register(with registrar: FlutterPluginRegistrar) {
    let instance = PocketPlatformPlugin()
    let channel = FlutterMethodChannel(
      name: "com.pocketnexus.host/platform",
      binaryMessenger: registrar.messenger()
    )
    instance.channel = channel
    PocketPlatformPlugin.shared = instance
    let pendingURLs = PocketPlatformPlugin.preconfigurationURLs
    PocketPlatformPlugin.preconfigurationURLs.removeAll(keepingCapacity: false)
    pendingURLs.forEach { value in
      if let url = URL(string: value) {
        instance.receive(url)
      }
    }
    registrar.addMethodCallDelegate(instance, channel: channel)
  }

  /// Forward a URL from the consuming app's SceneDelegate.
  ///
  /// The URL is dropped unless the consumer's static metadata allows the
  /// scheme. Before Dart activation it is only retained as bounded native
  /// cold-start state; it is never exposed to a guest until Dart configures
  /// the same scheme.
  public static func handleIncomingURL(_ url: URL) {
    if let plugin = shared {
      plugin.receive(url)
      return
    }
    guard let scheme = url.scheme.flatMap(validatedScheme),
          staticOptInAllows(scheme: scheme)
    else {
      return
    }
    let value = url.absoluteString
    guard !value.isEmpty else { return }
    if preconfigurationURLs.count == 2 {
      preconfigurationURLs.removeFirst()
    }
    preconfigurationURLs.append(value)
  }

  /// Alias used by consumers whose AppDelegate names the callback OpenURL.
  public static func handleOpenURL(_ url: URL) {
    handleIncomingURL(url)
  }

  public func handle(_ call: FlutterMethodCall, result: @escaping FlutterResult) {
    switch call.method {
    case "configureDeepLinks":
      configureDeepLinks(call.arguments, result: result)
    case "getInitialLink":
      result(["uri": (initialLink as Any?) ?? NSNull()])
    case "getLatestLink":
      result(["uri": (latestLink as Any?) ?? NSNull()])
    case "disableDeepLinks":
      disableDeepLinks()
      result(["disabled": true])
    default:
      result(FlutterMethodNotImplemented)
    }
  }

  public func detachFromEngine(for registrar: FlutterPluginRegistrar) {
    disableDeepLinks()
    channel = nil
    if PocketPlatformPlugin.shared === self {
      PocketPlatformPlugin.shared = nil
    }
  }

  private func configureDeepLinks(_ rawArguments: Any?, result: @escaping FlutterResult) {
    guard let args = rawArguments as? [String: Any],
          let enabled = args["enabled"] as? Bool,
          enabled,
          let rawScheme = args["scheme"] as? String,
          let scheme = Self.validatedScheme(rawScheme)
    else {
      result(FlutterError(
        code: "platform_invalid_argument",
        message: "deep links require enabled=true and a custom URL scheme",
        details: nil
      ))
      return
    }

    guard Self.staticOptInAllows(scheme: scheme) else {
      result(FlutterError(
        code: "platform_deep_links_not_enabled",
        message: "PocketDeepLinksEnabled and PocketDeepLinkSchemes do not allow this scheme",
        details: ["scheme": scheme]
      ))
      return
    }

    if configuredScheme != scheme {
      initialLink = nil
      latestLink = nil
      recentURLs.removeAll(keepingCapacity: true)
    }
    linksEnabled = true
    configuredScheme = scheme
    result(["enabled": true, "scheme": scheme])
  }

  private func disableDeepLinks() {
    preconfigurationCaptureOpen = false
    linksEnabled = false
    configuredScheme = nil
    initialLink = nil
    latestLink = nil
    recentURLs.removeAll(keepingCapacity: false)
  }

  private func receive(_ url: URL) {
    guard let incomingScheme = url.scheme.flatMap(Self.validatedScheme),
          Self.staticOptInAllows(scheme: incomingScheme)
    else {
      return
    }
    if !linksEnabled {
      guard preconfigurationCaptureOpen,
            configuredScheme == nil || configuredScheme == incomingScheme
      else { return }
      configuredScheme = incomingScheme
    } else if configuredScheme != incomingScheme {
      return
    }
    let uri = url.absoluteString
    guard !uri.isEmpty else { return }
    let now = ProcessInfo.processInfo.systemUptime
    if recentURLs.contains(where: {
      $0.value == uri && now >= $0.atUptime && now - $0.atUptime < deepLinkDedupeWindow
    }) {
      return
    }
    recentURLs.append(RecentURL(value: uri, atUptime: now))
    while recentURLs.count > maxRecentURLs {
      recentURLs.removeFirst()
    }
    if initialLink == nil {
      initialLink = uri
    }
    latestLink = uri
    if linksEnabled {
      channel?.invokeMethod("onDeepLink", arguments: ["uri": uri])
    }
  }

  private static func staticOptInAllows(scheme: String) -> Bool {
    let enabled = Bundle.main.object(forInfoDictionaryKey: "PocketDeepLinksEnabled") as? Bool ?? false
    guard enabled else { return false }
    let raw = Bundle.main.object(forInfoDictionaryKey: "PocketDeepLinkSchemes")
    let schemes: [String]
    if let values = raw as? [String] {
      schemes = values
    } else if let value = raw as? String {
      schemes = [value]
    } else {
      schemes = []
    }
    return schemes.contains { validatedScheme($0) == scheme }
  }

  private static func validatedScheme(_ raw: String) -> String? {
    let scheme = raw
    let forbidden = Set(["http", "https", "file", "data", "javascript", "content", "intent"])
    guard scheme.count >= 1,
          scheme.count <= 32,
          scheme == scheme.lowercased(),
          !forbidden.contains(scheme)
    else { return nil }
    let scalars = Array(scheme.unicodeScalars)
    guard let first = scalars.first, first.value >= 0x61, first.value <= 0x7a else {
      return nil
    }
    guard scalars.dropFirst().allSatisfy({ scalar in
      (scalar.value >= 0x61 && scalar.value <= 0x7a) ||
        (scalar.value >= 0x30 && scalar.value <= 0x39) ||
        scalar.value == 0x2b || scalar.value == 0x2e || scalar.value == 0x2d
    }) else {
      return nil
    }
    return scheme
  }
}
