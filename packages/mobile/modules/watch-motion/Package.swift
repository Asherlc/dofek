// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "WatchMotionLib",
    platforms: [.macOS(.v13), .iOS(.v16)],
    targets: [
        .target(
            name: "WatchMotionLib",
            path: "ios",
            exclude: ["WatchMotionModule.swift", "ExpoWatchMotion.podspec"],
            sources: ["SampleFileParser.swift"]
        ),
        .testTarget(
            name: "WatchMotionTests",
            dependencies: ["WatchMotionLib"],
            path: "Tests"
        ),
    ]
)
