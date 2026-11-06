// swift-tools-version: 5.9

import PackageDescription

let package = Package(
    name: "pocket_sensors",
    platforms: [.iOS(.v15)],
    products: [
        .library(name: "pocket-sensors", targets: ["pocket_sensors"]),
    ],
    targets: [
        .target(name: "pocket_sensors"),
        .testTarget(
            name: "pocket_sensorsTests",
            dependencies: ["pocket_sensors"]
        ),
    ]
)
