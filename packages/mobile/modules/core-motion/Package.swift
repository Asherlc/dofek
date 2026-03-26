// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "CoreMotionLib",
    platforms: [.macOS(.v13), .iOS(.v16)],
    targets: [
        .target(
            name: "CoreMotionLib",
            path: "ios",
            exclude: ["CoreMotionModule.swift", "ExpoCoreMotion.podspec"]
        ),
    ]
)
