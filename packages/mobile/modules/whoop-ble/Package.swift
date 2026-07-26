// swift-tools-version: 5.9
import Foundation
import PackageDescription

let expoFiles = ["WhoopBleModule.swift", "ExpoWhoopBle.podspec"]
let expoExclusions = expoFiles.filter {
    FileManager.default.fileExists(atPath: "ios/\($0)")
}

let package = Package(
    name: "WhoopBLE",
    platforms: [.macOS(.v13), .iOS(.v16)],
    products: [
        .library(name: "WhoopBLE", targets: ["WhoopBLE"]),
    ],
    targets: [
        .target(
            name: "WhoopBLE",
            path: "ios",
            exclude: expoExclusions
        ),
        .testTarget(
            name: "WhoopBLETests",
            dependencies: ["WhoopBLE"],
            path: "Tests",
            resources: [.copy("fixtures")]
        ),
    ]
)
