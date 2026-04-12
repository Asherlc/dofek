import XCTest
@testable import WatchMotionLib

/// Tests the compression round-trip between Watch and iPhone.
///
/// The Watch compresses samples with NSData.compressed(using: .zlib),
/// and the iPhone decompresses them with NSData.decompressed(using: .zlib).
/// This test verifies the full round-trip works correctly, catching
/// format mismatches like the gzip-vs-zlib bug that caused samples to
/// get stuck in "pending" (the iPhone checked for gzip magic bytes
/// but the Watch produces zlib format).
final class SampleFileParserTests: XCTestCase {

    // MARK: - Round-trip (Watch compress → iPhone decompress)

    func testRoundTripZlibCompression() throws {
        let samples: [[String: Any]] = [
            ["timestamp": "2026-03-28T10:00:00.000Z", "x": 0.01, "y": -0.98, "z": 0.04],
            ["timestamp": "2026-03-28T10:00:00.020Z", "x": 0.02, "y": -0.97, "z": 0.05],
        ]

        // Simulate Watch: compress with zlib (exactly what TransferManager does)
        let compressed = try SampleFileParser.compress(samples)

        // Verify it's actually compressed (should be smaller than original JSON)
        let rawJson = try JSONSerialization.data(withJSONObject: samples)
        XCTAssertLessThan(compressed.count, rawJson.count,
            "Compressed data should be smaller than raw JSON")

        // NSData.compressed(using: .zlib) produces raw DEFLATE — verify it does NOT
        // start with gzip magic bytes (this was the original bug: code checked for
        // 0x1f 0x8b, which never matches, so compressed data was treated as plain JSON)
        XCTAssertNotEqual(Array(compressed.prefix(2)), [0x1f, 0x8b] as [UInt8],
            "NSData.compressed(using: .zlib) should not produce gzip magic bytes")

        // Simulate iPhone: parse the compressed file
        let parsed = try SampleFileParser.parse(compressed)

        XCTAssertEqual(parsed.count, 2)
        XCTAssertEqual(parsed[0]["timestamp"] as? String, "2026-03-28T10:00:00.000Z")
        // swiftlint:disable:next force_cast
        XCTAssertEqual(parsed[0]["x"] as! Double, 0.01, accuracy: 0.001)
        // swiftlint:disable:next force_cast
        XCTAssertEqual(parsed[0]["y"] as! Double, -0.98, accuracy: 0.001)
        // swiftlint:disable:next force_cast
        XCTAssertEqual(parsed[0]["z"] as! Double, 0.04, accuracy: 0.001)
        XCTAssertEqual(parsed[1]["timestamp"] as? String, "2026-03-28T10:00:00.020Z")
    }

    func testRoundTripLargeBatch() throws {
        // Simulate a realistic Watch transfer: 50 Hz × 60 seconds = 3000 samples
        var samples: [[String: Any]] = []
        for index in 0..<3000 {
            samples.append([
                "timestamp": "2026-03-28T10:00:\(String(format: "%02d", index / 50)).\(String(format: "%03d", (index % 50) * 20))Z",
                "x": Double.random(in: -2...2),
                "y": Double.random(in: -2...2),
                "z": Double.random(in: -2...2),
            ])
        }

        let compressed = try SampleFileParser.compress(samples)
        let parsed = try SampleFileParser.parse(compressed)

        XCTAssertEqual(parsed.count, 3000)
    }

    // MARK: - Plain JSON (uncompressed fallback)

    func testParsePlainJson() throws {
        let samples: [[String: Any]] = [
            ["timestamp": "2026-03-28T12:00:00.000Z", "x": 0.5, "y": -0.3, "z": 0.8],
        ]

        let jsonData = try JSONSerialization.data(withJSONObject: samples)

        let parsed = try SampleFileParser.parse(jsonData)

        XCTAssertEqual(parsed.count, 1)
        XCTAssertEqual(parsed[0]["timestamp"] as? String, "2026-03-28T12:00:00.000Z")
    }

    // MARK: - Error cases

    func testParseInvalidDataThrows() {
        let garbage = Data([0x00, 0x01, 0x02, 0x03, 0xFF])

        XCTAssertThrowsError(try SampleFileParser.parse(garbage))
    }

    func testParseNonArrayJsonThrows() {
        let jsonObject: [String: Any] = ["not": "an array"]
        // swiftlint:disable:next force_try
        let jsonData = try! JSONSerialization.data(withJSONObject: jsonObject)

        XCTAssertThrowsError(try SampleFileParser.parse(jsonData)) { error in
            XCTAssertTrue(error is SampleFileParserError)
        }
    }

    func testParseEmptyArraySucceeds() throws {
        let emptyArray: [[String: Any]] = []
        let jsonData = try JSONSerialization.data(withJSONObject: emptyArray)

        let parsed = try SampleFileParser.parse(jsonData)
        XCTAssertEqual(parsed.count, 0)
    }
}
