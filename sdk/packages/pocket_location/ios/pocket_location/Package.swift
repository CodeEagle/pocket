// swift-tools-version: 5.9

import PackageDescription

let package = Package(
    name: "pocket_location",
    platforms: [.iOS(.v15)],
    products: [
        .library(name: "pocket-location", targets: ["pocket_location"]),
    ],
    targets: [
        .target(name: "pocket_location"),
    ]
)
