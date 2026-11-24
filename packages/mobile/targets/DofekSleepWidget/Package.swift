// swift-tools-version: 5.9
#if canImport(PackageDescription)
import PackageDescription

let package = Package(
    name: "DofekSleepWidgetCore",
    platforms: [
        .macOS(.v13),
        .iOS(.v16),
    ],
    targets: [
        .target(
            name: "DofekSleepWidgetCore",
            path: ".",
            exclude: [
                "AGENTS.md",
                "CLAUDE.md",
                "DofekSleepWidget.swift",
                "DofekSleepWidgetViews.swift",
                "GEMINI.md",
                "Info.plist",
                "README.md",
                "SleepWidgetTimeline.swift",
                "Tests",
                "expo-target.config.js",
                "mutantkit.yml",
            ],
            sources: [
                "SleepWidgetSnapshot.swift",
                "SleepWidgetSnapshotStore.swift",
            ]
        ),
        .testTarget(
            name: "DofekSleepWidgetCoreTests",
            dependencies: ["DofekSleepWidgetCore"],
            path: "Tests",
            sources: [
                "SleepWidgetSnapshot.test.swift",
            ]
        ),
    ]
)
#endif
