"""Opt-in URL-scheme transport configuration; no JS routing policy lives here."""
from pathlib import Path
import plistlib
import re
import sys
import xml.etree.ElementTree as ET

ANDROID = "http://schemas.android.com/apk/res/android"
ET.register_namespace("android", ANDROID)

SCENE_CLASS = "$(PRODUCT_MODULE_NAME).PocketDeepLinkSceneDelegate"
SCENE_MARKER = "// Pocket optional URL-scheme ingress."
SCENE_SOURCE = '''
// Pocket optional URL-scheme ingress.
class PocketDeepLinkSceneDelegate: FlutterSceneDelegate {
  override func scene(
    _ scene: UIScene,
    willConnectTo session: UISceneSession,
    options connectionOptions: UIScene.ConnectionOptions
  ) {
    super.scene(scene, willConnectTo: session, options: connectionOptions)
    if let url = connectionOptions.urlContexts.first?.url {
      PocketPlatformPlugin.handleIncomingURL(url)
    }
  }

  override func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
    super.scene(scene, openURLContexts: URLContexts)
    if let url = URLContexts.first?.url {
      PocketPlatformPlugin.handleIncomingURL(url)
    }
  }
}
'''


def patch(flutter_root: Path, scheme: str) -> None:
    if not re.fullmatch(r"[a-z][a-z0-9+.-]{0,31}", scheme) or scheme in {
        "http", "https", "file", "content", "data", "javascript", "intent"
    }:
        raise ValueError("expected a custom lowercase URL scheme")
    changes: dict[Path, bytes] = {}
    plist_path = flutter_root / "ios/Runner/Info.plist"
    if plist_path.exists():
        original = plist_path.read_bytes()
        plist = plistlib.loads(original)
        if not isinstance(plist, dict):
            raise ValueError("Info.plist must have a root dictionary")
        urls = plist.setdefault("CFBundleURLTypes", [])
        if not isinstance(urls, list) or any(not isinstance(item, dict) for item in urls):
            raise ValueError("CFBundleURLTypes must be an array of dictionaries")
        if not any(scheme in item.get("CFBundleURLSchemes", []) for item in urls):
            urls.append({"CFBundleURLName": "dev.pocketjs.platform", "CFBundleURLSchemes": [scheme]})
        plist["PocketDeepLinksEnabled"] = True
        plist["PocketDeepLinkSchemes"] = [scheme]
        plist["FlutterDeepLinkingEnabled"] = False
        manifest = plist.get("UIApplicationSceneManifest", {})
        configurations = manifest.get("UISceneConfigurations", {})
        scene_entries = [entry for entries in configurations.values() for entry in entries]
        if not scene_entries:
            raise ValueError("run the SDK iOS scene lifecycle patch before enabling Deep Links")
        for entry in scene_entries:
            previous = entry.get("UISceneDelegateClassName")
            if previous not in {"FlutterSceneDelegate", "Flutter.FlutterSceneDelegate", SCENE_CLASS}:
                raise ValueError("custom SceneDelegate: keep it and call PocketPlatformPlugin.handleIncomingURL(url) manually")
            entry["UISceneDelegateClassName"] = SCENE_CLASS
        delegate = flutter_root / "ios/Runner/AppDelegate.swift"
        source = delegate.read_text()
        if "class PocketDeepLinkSceneDelegate" in source and SCENE_MARKER not in source:
            raise ValueError("custom PocketDeepLinkSceneDelegate must be integrated manually")
        if not re.search(r"^import pocket_platform\s*$", source, re.M):
            source = "import pocket_platform\n" + source
        if SCENE_MARKER not in source:
            source += SCENE_SOURCE
        changes[delegate] = source.encode()
        # Avoid reformatting the consumer's plist on every build.
        if plist != plistlib.loads(original):
            changes[plist_path] = plistlib.dumps(plist, sort_keys=False)

    manifest_path = flutter_root / "android/app/src/main/AndroidManifest.xml"
    if manifest_path.exists():
        parser = ET.XMLParser(target=ET.TreeBuilder(insert_comments=True))
        tree = ET.fromstring(manifest_path.read_bytes(), parser=parser)
        application = tree.find("application")
        if application is None:
            raise ValueError("AndroidManifest.xml has no application")
        attr = lambda name: f"{{{ANDROID}}}{name}"
        activities = application.findall("activity")
        activity = next((a for a in activities if any(
            action.get(attr("name")) == "android.intent.action.MAIN"
            for action in a.findall("intent-filter/action")
        )), None)
        if activity is None:
            raise ValueError("AndroidManifest.xml has no launcher activity; integrate its URL filter manually")
        before = ET.tostring(tree)
        metadata = {
            "dev.pocketjs.platform.DEEP_LINKS_ENABLED": "true",
            "dev.pocketjs.platform.DEEP_LINK_SCHEMES": scheme,
            "flutter_deeplinking_enabled": "false",
        }
        for name, value in metadata.items():
            node = next((n for n in application.findall("meta-data") if n.get(attr("name")) == name), None)
            if node is None:
                node = ET.SubElement(application, "meta-data", {attr("name"): name})
            node.set(attr("value"), value)
        has_filter = any(
            any(a.get(attr("name")) == "android.intent.action.VIEW" for a in f.findall("action"))
            and any(d.get(attr("scheme")) == scheme for d in f.findall("data"))
            for f in activity.findall("intent-filter")
        )
        if not has_filter:
            intent = ET.SubElement(activity, "intent-filter")
            ET.SubElement(intent, "action", {attr("name"): "android.intent.action.VIEW"})
            for category in ("DEFAULT", "BROWSABLE"):
                ET.SubElement(intent, "category", {attr("name"): f"android.intent.category.{category}"})
            ET.SubElement(intent, "data", {attr("scheme"): scheme})
        if before != ET.tostring(tree):
            ET.indent(tree, space="    ")
            changes[manifest_path] = ET.tostring(tree, encoding="utf-8", xml_declaration=True) + b"\n"

    # Validate all inputs before writing any consumer file.
    for path, content in changes.items():
        if path.read_bytes() != content:
            path.write_bytes(content)


if __name__ == "__main__":
    try:
        patch(Path(sys.argv[1]), sys.argv[2])
    except (ValueError, OSError, KeyError, TypeError, ET.ParseError, plistlib.InvalidFileException) as error:
        sys.exit(str(error))
