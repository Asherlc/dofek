// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "BleHeartRateLib",
    platforms: [.macOS(.v13), .iOS(.v16)],
    targets: [
        .target(
            name: "BleHeartRateLib",
            path: "ios",
            exclude: ["BleHeartRateModule.swift", "ExpoBleHeartRate.podspec"]
        ),
        .testTarget(
            name: "BleHeartRateLibTests",
            dependencies: ["BleHeartRateLib"],
            path: "Tests"
        ),
    ]
)
