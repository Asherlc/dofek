// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "AppStoreBillingLib",
    platforms: [.macOS(.v13), .iOS(.v16)],
    targets: [
        .target(
            name: "AppStoreBillingLib",
            path: "ios",
            exclude: ["AppStoreBillingModule.swift", "ExpoAppStoreBilling.podspec"]
        ),
        .testTarget(
            name: "AppStoreBillingLibTests",
            dependencies: ["AppStoreBillingLib"],
            path: "Tests"
        ),
    ]
)
