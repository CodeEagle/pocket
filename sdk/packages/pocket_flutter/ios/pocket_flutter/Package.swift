// swift-tools-version: 5.9

import PackageDescription

let package = Package(
    name: "pocket_flutter",
    platforms: [.iOS(.v15)],
    products: [
        .library(name: "pocket-flutter", targets: ["pocket_flutter"]),
    ],
    targets: [
        .target(
            name: "pocket_flutter",
            dependencies: ["PocketFlutterNative"],
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
