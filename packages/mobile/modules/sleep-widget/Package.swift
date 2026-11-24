// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "SleepWidgetLib",
    platforms: [.macOS(.v13), .iOS(.v16)],
    targets: [
        .target(
            name: "SleepWidgetLib",
            path: "ios",
            exclude: [
                "ExpoSleepWidget.podspec",
                "SleepWidgetModule.swift",
            ]
        ),
        .testTarget(
            name: "SleepWidgetLibTests",
            dependencies: ["SleepWidgetLib"],
            path: "Tests"
        ),
    ]
)
