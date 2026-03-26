// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "WhoopBleLib",
    platforms: [.macOS(.v13), .iOS(.v16)],
    targets: [
        .target(
            name: "WhoopBleLib",
            path: "ios",
            exclude: ["WhoopBleModule.swift", "ExpoWhoopBle.podspec"]
        ),
        .testTarget(
            name: "WhoopBleLibTests",
            dependencies: ["WhoopBleLib"],
            path: "Tests"
        ),
    ]
)
