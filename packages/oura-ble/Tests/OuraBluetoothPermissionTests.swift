import Foundation
import XCTest
@testable import OuraBLE

// Build an isolated, directory-backed Bundle so the guard can be exercised
// without touching the process-wide Bundle.main or the real app Info.plist.
private func withInfoPlist(
    _ info: [String: String],
    perform: (Bundle) async throws -> Void
) async throws {
    let directory = FileManager.default.temporaryDirectory
        .appendingPathComponent("OuraBLE-\(UUID().uuidString).bundle", isDirectory: true)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: directory) }
    let plist = try PropertyListSerialization.data(fromPropertyList: info, format: .xml, options: 0)
    try plist.write(to: directory.appendingPathComponent("Info.plist"))
    let bundle = try XCTUnwrap(Bundle(path: directory.path))
    try await perform(bundle)
}

private let manifestMessage =
    "Add NSBluetoothAlwaysUsageDescription to the iOS app's Info.plist."

@MainActor
final class OuraBluetoothPermissionTests: XCTestCase {
    func testDiscoverRejectsMissingUsageDescription() async throws {
        try await withInfoPlist([:]) { bundle in
            let transport = OuraBluetoothTransport(bundle: bundle)
            do {
                _ = try await transport.discover()
                XCTFail("discover() must reject a missing NSBluetoothAlwaysUsageDescription")
            } catch let error as OuraAdapterError {
                XCTAssertEqual(error.message, manifestMessage)
            }
        }
    }

    func testDiscoverRejectsEmptyUsageDescription() async throws {
        try await withInfoPlist(["NSBluetoothAlwaysUsageDescription": ""]) { bundle in
            let transport = OuraBluetoothTransport(bundle: bundle)
            do {
                _ = try await transport.discover()
                XCTFail("discover() must reject an empty NSBluetoothAlwaysUsageDescription")
            } catch let error as OuraAdapterError {
                XCTAssertEqual(error.message, manifestMessage)
            }
        }
    }

    func testConnectRejectsMissingUsageDescription() async throws {
        try await withInfoPlist([:]) { bundle in
            let transport = OuraBluetoothTransport(bundle: bundle)
            do {
                try await transport.connect(peripheralID: UUID())
                XCTFail("connect() must reject a missing NSBluetoothAlwaysUsageDescription")
            } catch let error as OuraAdapterError {
                XCTAssertEqual(error.message, manifestMessage)
            }
        }
    }

    func testConnectRejectsEmptyUsageDescription() async throws {
        try await withInfoPlist(["NSBluetoothAlwaysUsageDescription": ""]) { bundle in
            let transport = OuraBluetoothTransport(bundle: bundle)
            do {
                try await transport.connect(peripheralID: UUID())
                XCTFail("connect() must reject an empty NSBluetoothAlwaysUsageDescription")
            } catch let error as OuraAdapterError {
                XCTAssertEqual(error.message, manifestMessage)
            }
        }
    }
}
