// swift-tools-version: 5.9

import PackageDescription

let package = Package(
    name: "pocket_platform",
    platforms: [.iOS(.v15)],
    products: [
        .library(name: "pocket-platform", targets: ["pocket_platform"]),
    ],
    targets: [
        .target(name: "pocket_platform"),
    ]
)
