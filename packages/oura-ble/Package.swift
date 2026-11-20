// swift-tools-version: 5.9
import Foundation
import PackageDescription

let packageDirectory = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
let generatedSources = packageDirectory.appendingPathComponent("ios/generated")
let excludedSources = ["OuraBleModule.swift", "OuraBle.podspec"]
    + (FileManager.default.fileExists(atPath: generatedSources.path) ? ["generated"] : [])

let package = Package(
    name: "OuraBLE",
    platforms: [.macOS(.v13), .iOS("16.4")],
    products: [
        .library(name: "OuraBLE", targets: ["OuraBLE"]),
    ],
    targets: [
        .target(
            name: "OuraBLE",
            path: "ios",
            exclude: excludedSources
        ),
        .testTarget(
            name: "OuraBLETests",
            dependencies: ["OuraBLE"],
            path: "Tests"
        ),
    ]
)
