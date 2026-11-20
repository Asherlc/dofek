import XCTest
@testable import WhoopBLE

// Fixture: compare the store's synchronous commit + indexing path against the
// former per-notification direct insert into the indexed `samples` table.
extension WhoopBleSampleStoreTests {
    func testLowFanoutCaptureWritesAtLeastThirtyPercentFewerWALBytes() throws {
        let captureDirectory = try directory()
        let baselineDirectory = try directory()
        let (capture, captureProbe) = try SQLiteWorkProbe.opening {
            try WhoopBleSampleStore(directory: captureDirectory)
        }
        let (baseline, baselineProbe) = try SQLiteWorkProbe.opening {
            try WhoopBleSampleStore(directory: baselineDirectory)
        }
        try capture.configure(owner)
        try baseline.configure(owner)
        try captureProbe.executeFixture("PRAGMA wal_checkpoint(TRUNCATE)")
        try baselineProbe.executeFixture("PRAGMA wal_checkpoint(TRUNCATE)")
        try captureProbe.executeFixture("PRAGMA wal_autocheckpoint = 0")
        try baselineProbe.executeFixture("PRAGMA wal_autocheckpoint = 0")

        for second in 1...20 {
            let realtime = samples([second])
            var record = realtime[0]
            record["frameHex"] = String(repeating: "a1", count: 124)
            let batch: [WhoopUploadStream: [[String: Any]]] = [.sensorRecords: [record], .realtime: realtime]
            try capture.append(deviceId: "watch", samplesByStream: batch)
            try appendDirectIndexed(deviceId: "watch", samplesByStream: batch, probe: baselineProbe)
            if second % 5 == 0 { try capture.drainInbox() }
        }

        for stream in [WhoopUploadStream.sensorRecords, .realtime] {
            XCTAssertEqual(try capture.queuedCount(stream: stream), 20)
            XCTAssertEqual(try baseline.queuedCount(stream: stream), 20)
        }
        let captureFrames = try walFrames(in: captureDirectory, probe: captureProbe)
        let baselineFrames = try walFrames(in: baselineDirectory, probe: baselineProbe)
        XCTAssertLessThan(
            captureFrames, baselineFrames * 7 / 10,
            "Low-fanout capture + indexing WAL \(captureFrames) frames should be ≥30% below direct indexed \(baselineFrames)"
        )
    }

    // Production-scale fanout: ~100 realistic IMU samples per notification, as
    // observed in Axiom captures (5,800 IMU samples / 58 realtime records in 58 s).
    // Promotion follows the same five-notification cadence as the low-fanout replay.
    func testHighFanoutCaptureWritesAtLeastFifteenPercentFewerWALBytes() throws {
        let captureDirectory = try directory()
        let baselineDirectory = try directory()
        let (capture, captureProbe) = try SQLiteWorkProbe.opening {
            try WhoopBleSampleStore(directory: captureDirectory)
        }
        let (baseline, baselineProbe) = try SQLiteWorkProbe.opening {
            try WhoopBleSampleStore(directory: baselineDirectory)
        }
        try capture.configure(owner)
        try baseline.configure(owner)
        try captureProbe.executeFixture("PRAGMA wal_checkpoint(TRUNCATE)")
        try baselineProbe.executeFixture("PRAGMA wal_checkpoint(TRUNCATE)")
        try captureProbe.executeFixture("PRAGMA wal_autocheckpoint = 0")
        try baselineProbe.executeFixture("PRAGMA wal_autocheckpoint = 0")

        let formatter = timestampFormatter()
        let total = 120
        for notification in 1...total {
            let batch: [WhoopUploadStream: [[String: Any]]] = [
                .imu: imuSamples(notification, count: 100),
                .realtime: [realtimeSample(notification, formatter: formatter)],
                .sensorRecords: [rawRecord(notification, formatter: formatter)],
            ]
            try capture.append(deviceId: "watch", samplesByStream: batch)
            try appendDirectIndexed(deviceId: "watch", samplesByStream: batch, probe: baselineProbe)
            if notification % 5 == 0 { try capture.drainInbox() }
        }

        let expected = total * 100
        XCTAssertEqual(try capture.queuedCount(stream: .imu, limit: expected), expected)
        XCTAssertEqual(try baseline.queuedCount(stream: .imu, limit: expected), expected)
        let captureFrames = try walFrames(in: captureDirectory, probe: captureProbe)
        let baselineFrames = try walFrames(in: baselineDirectory, probe: baselineProbe)
        let reduction = Double(baselineFrames - captureFrames) / Double(baselineFrames) * 100
        XCTAssertLessThan(
            captureFrames, baselineFrames * 85 / 100,
            """
            High-fanout capture + indexing WAL \(captureFrames) frames should be ≥15% below \
            direct indexed \(baselineFrames); observed \(String(format: "%.1f%%", reduction))
            """
        )
    }

    // MARK: - Fixtures

    private func timestampFormatter() -> ISO8601DateFormatter {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }

    private func baseTime(_ notification: Int) -> Date {
        Date(timeIntervalSince1970: 1_793_000_000 + Double(notification) * 60)
    }

    private func imuSamples(_ notification: Int, count: Int) -> [[String: Any]] {
        // Deterministic raw int16 readings converted with the parser's scales,
        // then serialized by the production serializer (Float widened to Double).
        let accelerometerScale: Float = 1.0 / 4096.0
        let gyroscopeScale: Float = (1.0 / 16.4) * (.pi / 180.0)
        let baseSeconds = UInt32(1_793_000_000 + notification * 60)
        func raw(_ value: Double, _ magnitude: Double) -> Int16 {
            Int16(truncatingIfNeeded: Int((value * magnitude).rounded()))
        }
        let samples = (0..<count).map { index -> WhoopImuSample in
            let phase = Double(notification * count + index) * 0.1
            return WhoopImuSample(
                timestampSeconds: baseSeconds, subSeconds: 0,
                sampleIndex: index, samplesInFrame: count,
                accelerometerX: Float(raw(sin(phase), 3000)) * accelerometerScale,
                accelerometerY: Float(raw(cos(phase), 3000)) * accelerometerScale,
                accelerometerZ: Float(raw(sin(phase * 0.5) + 1, 3000)) * accelerometerScale,
                gyroscopeX: Float(raw(sin(phase * 2) * 0.2, 1000)) * gyroscopeScale,
                gyroscopeY: Float(raw(cos(phase * 2) * 0.3, 1000)) * gyroscopeScale,
                gyroscopeZ: Float(raw(sin(phase * 3) * 0.1, 1000)) * gyroscopeScale
            )
        }
        return WhoopBleSampleSerializer.imu(samples)
    }

    private func realtimeSample(_ notification: Int, formatter: ISO8601DateFormatter) -> [String: Any] {
        [
            "timestamp": formatter.string(from: baseTime(notification).addingTimeInterval(0.5)),
            "heartRateBpm": 60 + (notification % 20),
            "rrIntervalMs": 800 + (notification % 50),
            "quaternionW": 1.0,
            "quaternionX": sin(Double(notification) * 0.1),
            "quaternionY": cos(Double(notification) * 0.1),
            "quaternionZ": 0.0,
            "opticalRawHex": String(repeating: "a5", count: 18),
        ]
    }

    private func rawRecord(_ notification: Int, formatter: ISO8601DateFormatter) -> [String: Any] {
        [
            "timestamp": formatter.string(from: baseTime(notification).addingTimeInterval(0.75)),
            "captureId": String(format: "capture-%04d", notification),
            "frameHex": String(repeating: "a1", count: 124),
            "deviceInfo": ["model": "WHOOP MG", "firmware": "50.42.1.0"],
        ]
    }

    /// Replicate the former `appendLocked` writes with raw SQL: one stats
    /// received update, one indexed row per sample, and one erased update per
    /// notification, in a single transaction. No erasure cutoff is configured,
    /// so erasureTime equals the sample timestamp as in production.
    private func appendDirectIndexed(
        deviceId: String,
        samplesByStream: [WhoopUploadStream: [[String: Any]]],
        probe: SQLiteWorkProbe
    ) throws {
        let parser = ISO8601DateFormatter()
        parser.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        var script = "BEGIN IMMEDIATE;\n"
        for stream in WhoopUploadStream.allCases {
            guard let rows = samplesByStream[stream], !rows.isEmpty else { continue }
            script += "UPDATE stats SET received = received + \(rows.count) WHERE stream = '\(stream.rawValue)';\n"
            for row in rows {
                let timestamp = try XCTUnwrap(row["timestamp"] as? String)
                let date = try XCTUnwrap(parser.date(from: timestamp))
                let json = try JSONSerialization.data(withJSONObject: row, options: [.sortedKeys])
                let payload = json.map { String(format: "%02x", $0) }.joined()
                script += "INSERT INTO samples(stream, device, timestamp, payload) VALUES "
                script += "('\(stream.rawValue)', '\(deviceId)', \(date.timeIntervalSince1970), X'\(payload)');\n"
            }
            script += "UPDATE stats SET erased = erased + 0 WHERE stream = '\(stream.rawValue)';\n"
        }
        script += "COMMIT;\n"
        try probe.executeFixture(script)
    }

    /// Autocheckpoint is disabled for the measured fixture, so the WAL file holds
    /// every committed frame and its size converts directly to a frame count.
    private func walFrames(in directory: URL, probe: SQLiteWorkProbe) throws -> Int {
        let wal = directory.appendingPathComponent("samples.sqlite-wal")
        let bytes = try XCTUnwrap(FileManager.default.attributesOfItem(atPath: wal.path)[.size] as? Int)
        let pageSize = try probe.integer("PRAGMA page_size")
        return (bytes - 32) / (24 + pageSize)
    }
}
