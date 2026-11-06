// swift-tools-version: 5.9

import PackageDescription
import Foundation

// Flutter 3.47 supplies this package through its generated application graph.
// Keep it optional here so Flutter 3.35 can still resolve the plugin manifest.
let flutterFrameworkPath = "../FlutterFramework"
let hasFlutterFramework = FileManager.default.fileExists(
    atPath: URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent()
        .appendingPathComponent(flutterFrameworkPath)
        .standardized.path
)
let flutterPackageDependencies: [Package.Dependency] = hasFlutterFramework
    ? [.package(name: "FlutterFramework", path: flutterFrameworkPath)]
    : []
let flutterTargetDependencies: [Target.Dependency] = hasFlutterFramework
    ? [.product(name: "FlutterFramework", package: "FlutterFramework")]
    : []

let package = Package(
    name: "pocket_biometrics",
    platforms: [.iOS(.v15)],
    products: [
        .library(name: "pocket-biometrics", targets: ["pocket_biometrics"]),
    ],
    dependencies: flutterPackageDependencies,
    targets: [
        .target(
            name: "pocket_biometrics",
            dependencies: flutterTargetDependencies
        ),
    ]
)
