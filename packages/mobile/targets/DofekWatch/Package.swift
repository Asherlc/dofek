// swift-tools-version: 5.9
#if canImport(PackageDescription)
import PackageDescription

let package = Package(
    name: "DofekWatchTransferCore",
    platforms: [
        .macOS(.v13),
        .watchOS(.v10),
    ],
    targets: [
        .target(
            name: "DofekWatchTransferCore",
            path: ".",
            exclude: [
                "AccelerometerRecorder.swift",
                "AltimeterRecorder.swift",
                "AltitudeCalculator.swift",
                "Assets.xcassets",
                "AGENTS.md",
                "CLAUDE.md",
                "ContentView.swift",
                "DofekWatchApp.swift",
                "GEMINI.md",
                "GyroscopeRecorder.swift",
                "Info.plist",
                "README.md",
                "Tests",
                "TransferManager.swift",
                "WatchSessionDelegate.swift",
                "expo-target.config.js",
                "pods.rb",
            ],
            sources: [
                "AccelerometerTransferCursor.swift",
                "GyroscopeSampleBuffer.swift",
                "WatchAccountStateStore.swift",
            ]
        ),
        .testTarget(
            name: "DofekWatchTransferCoreTests",
            dependencies: ["DofekWatchTransferCore"],
            path: "Tests",
            exclude: [
                "AccelerometerRecorder.test.swift",
                "AltimeterRecorderBuffer.test.swift",
                "AltitudeCalculator.test.swift",
                "TransferManager.test.swift",
            ],
            sources: [
                "AccelerometerTransferCursor.test.swift",
                "GyroscopeSampleBuffer.test.swift",
                "WatchAccountStateStore.test.swift",
            ]
        ),
    ]
)
#endif
