// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "BackgroundRefreshLib",
    platforms: [.macOS(.v13), .iOS(.v16)],
    targets: [
        .target(
            name: "BackgroundRefreshLib",
            path: "ios",
            exclude: [
                "BackgroundRefreshAppDelegateSubscriber.swift",
                "BackgroundRefreshModule.swift",
                "ExpoBackgroundRefresh.podspec",
            ]
        ),
        .testTarget(
            name: "BackgroundRefreshLibTests",
            dependencies: ["BackgroundRefreshLib"],
            path: "Tests"
        ),
    ]
)
