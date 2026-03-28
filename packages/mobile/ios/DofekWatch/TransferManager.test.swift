import Compression
import Foundation
import XCTest

/// Tests for TransferManager's streaming compression.
/// These tests verify the compression pipeline without requiring CoreMotion or WCSession.
final class TransferManagerCompressionTests: XCTestCase {
    private var tempDirectory: URL!

    override func setUp() {
        super.setUp()
        tempDirectory = FileManager.default.temporaryDirectory
            .appendingPathComponent("compression-tests-\(UUID().uuidString)")
        try? FileManager.default.createDirectory(at: tempDirectory, withIntermediateDirectories: true)
    }

    override func tearDown() {
        try? FileManager.default.removeItem(at: tempDirectory)
        super.tearDown()
    }

    func testCompressFileProducesValidZlibData() throws {
        let sourceURL = tempDirectory.appendingPathComponent("input.json")
        let destURL = tempDirectory.appendingPathComponent("output.json.gz")

        let jsonPayload = """
        [{"timestamp":"2026-03-28T10:00:00.000Z","x":0.123,"y":-0.456,"z":0.789}]
        """
        try jsonPayload.data(using: .utf8)!.write(to: sourceURL)

        let compressedSize = try TransferManager.compressFile(from: sourceURL, to: destURL)

        XCTAssertGreaterThan(compressedSize, 0, "Compressed output should not be empty")

        // Decompress and verify round-trip
        let compressedData = try Data(contentsOf: destURL)
        let decompressed = try (compressedData as NSData).decompressed(using: .zlib) as Data
        let decompressedString = String(data: decompressed, encoding: .utf8)

        XCTAssertEqual(decompressedString, jsonPayload, "Round-trip should preserve data exactly")
    }

    func testCompressFileSmallerThanInput() throws {
        let sourceURL = tempDirectory.appendingPathComponent("large-input.json")
        let destURL = tempDirectory.appendingPathComponent("large-output.json.gz")

        // Generate repetitive JSON data (compresses well)
        var entries: [String] = []
        for index in 0..<10_000 {
            entries.append(
                "{\"timestamp\":\"2026-03-28T10:00:\(String(format: "%02d", index % 60)).000Z\","
                + "\"x\":0.123456,\"y\":-0.654321,\"z\":0.987654}"
            )
        }
        let jsonPayload = "[" + entries.joined(separator: ",") + "]"
        try jsonPayload.data(using: .utf8)!.write(to: sourceURL)

        let compressedSize = try TransferManager.compressFile(from: sourceURL, to: destURL)

        let originalSize = jsonPayload.data(using: .utf8)!.count
        XCTAssertLessThan(
            compressedSize, originalSize,
            "Compressed size (\(compressedSize)) should be smaller than original (\(originalSize))"
        )
    }

    func testCompressFileHandlesEmptyInput() throws {
        let sourceURL = tempDirectory.appendingPathComponent("empty.json")
        let destURL = tempDirectory.appendingPathComponent("empty.json.gz")

        try Data("[]".utf8).write(to: sourceURL)

        let compressedSize = try TransferManager.compressFile(from: sourceURL, to: destURL)

        XCTAssertGreaterThan(compressedSize, 0, "Even empty JSON should produce compressed output")

        let compressedData = try Data(contentsOf: destURL)
        let decompressed = try (compressedData as NSData).decompressed(using: .zlib) as Data
        XCTAssertEqual(String(data: decompressed, encoding: .utf8), "[]")
    }

    func testCompressFileThrowsForMissingSource() {
        let sourceURL = tempDirectory.appendingPathComponent("nonexistent.json")
        let destURL = tempDirectory.appendingPathComponent("output.json.gz")

        XCTAssertThrowsError(try TransferManager.compressFile(from: sourceURL, to: destURL))
    }
}
