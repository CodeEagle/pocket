// swift-tools-version: 5.9

import PackageDescription

let package = Package(
    name: "pocket_biometrics",
    platforms: [.iOS(.v15)],
    products: [
        .library(name: "pocket-biometrics", targets: ["pocket_biometrics"]),
    ],
    targets: [
        .target(name: "pocket_biometrics"),
    ]
)
