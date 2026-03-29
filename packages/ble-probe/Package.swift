// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "ble-probe",
    platforms: [.macOS(.v13)],
    targets: [
        .executableTarget(
            name: "ble-probe",
            path: "Sources/BleProbe"
        ),
    ]
)
