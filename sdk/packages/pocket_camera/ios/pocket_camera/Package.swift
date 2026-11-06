// swift-tools-version: 5.9

import PackageDescription

let package = Package(
    name: "pocket_camera",
    platforms: [.iOS(.v15)],
    products: [
        .library(name: "pocket-camera", targets: ["pocket_camera"]),
    ],
    targets: [
        .target(name: "pocket_camera"),
    ]
)
