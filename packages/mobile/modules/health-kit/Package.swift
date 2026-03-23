// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "HealthKitLib",
    platforms: [.macOS(.v13), .iOS(.v16)],
    targets: [
        .target(
            name: "HealthKitLib",
            path: "ios",
            exclude: ["HealthKitModule.swift", "ExpoHealthKit.podspec"]
        ),
        .testTarget(
            name: "HealthKitLibTests",
            dependencies: ["HealthKitLib"],
            path: "Tests"
        ),
    ]
)
