import Foundation
import XCTest

/// Tests for AccelerometerRecorder's streaming JSON batch logic.
///
/// The actual `streamSamplesToFile()` depends on CMSensorRecorder (hardware-only).
/// These tests verify the JSON batching/streaming format by reproducing the same
/// algorithm against in-memory sample data, ensuring the output is valid JSON.
final class AccelerometerRecorderStreamingTests: XCTestCase {
    private var tempDirectory: URL!

    override func setUp() {
        super.setUp()
        tempDirectory = FileManager.default.temporaryDirectory
            .appendingPathComponent("streaming-tests-\(UUID().uuidString)")
        try? FileManager.default.createDirectory(at: tempDirectory, withIntermediateDirectories: true)
    }

    override func tearDown() {
        try? FileManager.default.removeItem(at: tempDirectory)
        super.tearDown()
    }

    /// Reproduce the exact batch-streaming algorithm from streamSamplesToFile()
    /// with fake sample data to verify JSON validity.
    private func writeSamplesAsStreamingJSON(
        samples: [(timestamp: String, x: Double, y: Double, z: Double)],
        batchSize: Int
    ) throws -> (url: URL, count: Int) {
        let tempFile = tempDirectory.appendingPathComponent("test-\(UUID().uuidString).json")
        FileManager.default.createFile(atPath: tempFile.path, contents: nil)
        let handle = try FileHandle(forWritingTo: tempFile)
        defer { handle.closeFile() }

        handle.write(Data("[".utf8))

        var count = 0
        var totalFlushed = 0
        var batch: [String] = []
        batch.reserveCapacity(batchSize)

        for sample in samples {
            let entry = "{\"timestamp\":\"\(sample.timestamp)\","
                + "\"x\":\(sample.x),"
                + "\"y\":\(sample.y),"
                + "\"z\":\(sample.z)}"

            batch.append(entry)
            count += 1

            if batch.count >= batchSize {
                let prefix = totalFlushed > 0 ? "," : ""
                let chunk = prefix + batch.joined(separator: ",")
                handle.write(Data(chunk.utf8))
                totalFlushed += batch.count
                batch.removeAll(keepingCapacity: true)
            }
        }

        if !batch.isEmpty {
            let prefix = totalFlushed > 0 ? "," : ""
            let chunk = prefix + batch.joined(separator: ",")
            handle.write(Data(chunk.utf8))
        }

        handle.write(Data("]".utf8))

        return (url: tempFile, count: count)
    }

    func testStreamingProducesValidJSONForSingleBatch() throws {
        let samples = (0..<100).map { index in
            (timestamp: "2026-03-28T10:00:\(String(format: "%02d", index % 60)).000Z",
             x: 0.1 * Double(index), y: -0.2 * Double(index), z: 0.3 * Double(index))
        }

        let result = try writeSamplesAsStreamingJSON(samples: samples, batchSize: 5000)
        XCTAssertEqual(result.count, 100)

        let jsonData = try Data(contentsOf: result.url)
        let parsed = try JSONSerialization.jsonObject(with: jsonData) as? [[String: Any]]

        XCTAssertNotNil(parsed, "Output should be valid JSON")
        XCTAssertEqual(parsed?.count, 100, "Should contain all 100 samples")
        XCTAssertEqual(parsed?.first?["timestamp"] as? String, "2026-03-28T10:00:00.000Z")
    }

    func testStreamingProducesValidJSONAcrossMultipleBatches() throws {
        // Use a small batch size to force multiple flushes
        let sampleCount = 137 // Not a multiple of batch size
        let batchSize = 50

        let samples = (0..<sampleCount).map { index in
            (timestamp: "2026-03-28T10:\(String(format: "%02d", index / 60)):\(String(format: "%02d", index % 60)).000Z",
             x: Double(index), y: Double(-index), z: 9.81)
        }

        let result = try writeSamplesAsStreamingJSON(samples: samples, batchSize: batchSize)
        XCTAssertEqual(result.count, sampleCount)

        let jsonData = try Data(contentsOf: result.url)
        let parsed = try JSONSerialization.jsonObject(with: jsonData) as? [[String: Any]]

        XCTAssertNotNil(parsed, "Output should be valid JSON even with multiple batch flushes")
        XCTAssertEqual(parsed?.count, sampleCount,
                       "Should contain all \(sampleCount) samples across \(sampleCount / batchSize + 1) batches")
    }

    func testStreamingProducesValidJSONForEmptySamples() throws {
        let result = try writeSamplesAsStreamingJSON(samples: [], batchSize: 5000)
        XCTAssertEqual(result.count, 0)

        let jsonData = try Data(contentsOf: result.url)
        let parsed = try JSONSerialization.jsonObject(with: jsonData) as? [Any]

        XCTAssertNotNil(parsed, "Empty output should be valid JSON")
        XCTAssertEqual(parsed?.count, 0, "Should be an empty array")
    }

    func testStreamingProducesValidJSONForExactBatchBoundary() throws {
        // Exactly one full batch — tests that no trailing comma is added
        let batchSize = 50
        let samples = (0..<batchSize).map { index in
            (timestamp: "2026-03-28T10:00:\(String(format: "%02d", index % 60)).000Z",
             x: 1.0, y: 2.0, z: 3.0)
        }

        let result = try writeSamplesAsStreamingJSON(samples: samples, batchSize: batchSize)
        XCTAssertEqual(result.count, batchSize)

        let jsonData = try Data(contentsOf: result.url)
        let parsed = try JSONSerialization.jsonObject(with: jsonData) as? [[String: Any]]

        XCTAssertNotNil(parsed, "Exact batch boundary should produce valid JSON")
        XCTAssertEqual(parsed?.count, batchSize)
    }

    func testStreamingPreservesNumericPrecision() throws {
        let samples = [
            (timestamp: "2026-03-28T10:00:00.000Z",
             x: 0.123456789012345, y: -9.80665, z: 0.000001)
        ]

        let result = try writeSamplesAsStreamingJSON(samples: samples, batchSize: 5000)

        let jsonData = try Data(contentsOf: result.url)
        let parsed = try JSONSerialization.jsonObject(with: jsonData) as? [[String: Any]]

        let firstSample = try XCTUnwrap(parsed?.first)
        let parsedX = try XCTUnwrap(firstSample["x"] as? Double)
        let parsedY = try XCTUnwrap(firstSample["y"] as? Double)
        let parsedZ = try XCTUnwrap(firstSample["z"] as? Double)

        XCTAssertEqual(parsedX, 0.123456789012345, accuracy: 1e-15)
        XCTAssertEqual(parsedY, -9.80665, accuracy: 1e-15)
        XCTAssertEqual(parsedZ, 0.000001, accuracy: 1e-15)
    }
}
