import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { patchIosMinimum, patchIosSceneLifecycle } from "../../pocket.ts";

const generatedDelegate = `import Flutter
import UIKit

@main
@objc class AppDelegate: FlutterAppDelegate {
  override func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?
  ) -> Bool {
    GeneratedPluginRegistrant.register(with: self)
    return super.application(application, didFinishLaunchingWithOptions: launchOptions)
  }
}
`;

const customDelegate = `import Flutter
import UIKit

@main
@objc class AppDelegate: FlutterAppDelegate {
  private var channel: FlutterMethodChannel?

  override func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?
  ) -> Bool {
    channel = FlutterMethodChannel(name: "custom", binaryMessenger: window?.rootViewController as! FlutterBinaryMessenger)
    GeneratedPluginRegistrant.register(with: self)
    return super.application(application, didFinishLaunchingWithOptions: launchOptions)
  }
}
`;

const plainPlist = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
  <key>CFBundleName</key>
  <string>fixture</string>
</dict>
</plist>
`;

const scenePlist = plainPlist.replace(
  "</dict>",
  `	<key>UIApplicationSceneManifest</key>
	<dict>
		<key>UISceneConfigurations</key>
		<dict>
			<key>UIWindowSceneSessionRoleApplication</key>
			<array>
				<dict>
					<key>UISceneDelegateClassName</key>
					<string>FlutterSceneDelegate</string>
				</dict>
			</array>
		</dict>
	</dict>
</dict>`,
);

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "pocket-scene-test-"));
  mkdirSync(join(root, "Runner"));
  return root;
}

function writeIos(root: string, appDelegate: string, plist: string): void {
  writeFileSync(join(root, "Runner/AppDelegate.swift"), appDelegate);
  writeFileSync(join(root, "Runner/Info.plist"), plist);
}

function deploymentCount(text: string): number {
  return text.split("target.build_configurations.each { |config|").length - 1;
}

const generatedRoot = fixture();
try {
  writeIos(generatedRoot, generatedDelegate, plainPlist);
  patchIosSceneLifecycle(generatedRoot);
  const firstDelegate = readFileSync(join(generatedRoot, "Runner/AppDelegate.swift"), "utf8");
  const firstPlist = readFileSync(join(generatedRoot, "Runner/Info.plist"), "utf8");
  assert.match(firstDelegate, /FlutterPluginRegistrant/);
  assert.match(firstDelegate, /pluginRegistrant = self/);
  assert.match(firstPlist, /FlutterSceneDelegate/);
  patchIosSceneLifecycle(generatedRoot);
  assert.equal(readFileSync(join(generatedRoot, "Runner/AppDelegate.swift"), "utf8"), firstDelegate);
  assert.equal(readFileSync(join(generatedRoot, "Runner/Info.plist"), "utf8"), firstPlist);
} finally {
  rmSync(generatedRoot, { recursive: true, force: true });
}

const customRoot = fixture();
try {
  writeIos(customRoot, customDelegate, plainPlist);
  const beforeDelegate = readFileSync(join(customRoot, "Runner/AppDelegate.swift"), "utf8");
  assert.throws(() => patchIosSceneLifecycle(customRoot), /custom iOS AppDelegate is not scene-enabled/);
  assert.equal(readFileSync(join(customRoot, "Runner/AppDelegate.swift"), "utf8"), beforeDelegate);

  writeFileSync(join(customRoot, "Runner/Info.plist"), scenePlist);
  patchIosSceneLifecycle(customRoot);
  const preservedDelegate = readFileSync(join(customRoot, "Runner/AppDelegate.swift"), "utf8");
  assert.equal(preservedDelegate, beforeDelegate);
  assert.match(preservedDelegate, /FlutterMethodChannel/);
} finally {
  rmSync(customRoot, { recursive: true, force: true });
}

const podRoot = fixture();
try {
  writeIos(podRoot, generatedDelegate, plainPlist);
  writeFileSync(join(podRoot, "Podfile"), `platform :ios, '13.0'

post_install do |installer|
  installer.pods_project.targets.each do |target|
    flutter_additional_ios_build_settings(target)
  end
end
`);
  patchIosMinimum(podRoot);
  const once = readFileSync(join(podRoot, "Podfile"), "utf8");
  patchIosMinimum(podRoot);
  const twice = readFileSync(join(podRoot, "Podfile"), "utf8");
  assert.equal(twice, once);
  assert.equal(deploymentCount(twice), 1);
  assert.ok(existsSync(join(podRoot, "Podfile")));
} finally {
  rmSync(podRoot, { recursive: true, force: true });
}

console.log("tooling_scene.test: generated scene patch, custom delegate preservation, and idempotent Podfile patch passed");
