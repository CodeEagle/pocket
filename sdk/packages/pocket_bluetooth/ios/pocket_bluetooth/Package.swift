// swift-tools-version: 5.9

import PackageDescription

let package = Package(
    name: "pocket_bluetooth",
    platforms: [.iOS(.v15)],
    products: [
        .library(name: "pocket-bluetooth", targets: ["pocket_bluetooth"]),
    ],
    targets: [
        .target(name: "pocket_bluetooth"),
    ]
)
