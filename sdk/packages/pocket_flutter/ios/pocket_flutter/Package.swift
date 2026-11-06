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
    name: "pocket_flutter",
    platforms: [.iOS(.v15)],
    products: [
        .library(name: "pocket-flutter", targets: ["pocket_flutter"]),
    ],
    dependencies: flutterPackageDependencies,
    targets: [
        .target(
            name: "pocket_flutter",
            dependencies: flutterTargetDependencies + [
                .target(name: "PocketFlutterNative"),
            ],
            linkerSettings: [
                // Dart FFI resolves the Rust C ABI from the process image. The
                // archive has no direct Swift references, so retain every object.
                .unsafeFlags(["-Xlinker", "-all_load", "-Xlinker", "-export_dynamic"]),
                .linkedLibrary("c"),
                .linkedLibrary("m"),
                .linkedLibrary("iconv"),
                .linkedLibrary("c++"),
            ]
        ),
        .binaryTarget(
            name: "PocketFlutterNative",
            path: "Frameworks/PocketFlutter.xcframework"
        ),
    ]
)
