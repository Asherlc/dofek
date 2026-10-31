import Foundation
import XCTest
@testable import WhoopBLE

func capturedWhoopR18Data() throws -> Data {
    let url = try XCTUnwrap(Bundle.module.url(forResource: "imu-activation-capture", withExtension: "tsv", subdirectory: "fixtures"))
    let text = try String(contentsOf: url, encoding: .utf8)
    let hex = try XCTUnwrap(text.split(separator: "\n").compactMap { line -> String? in
        let value = String(line.split(separator: "\t").last ?? "")
        return value.count == 248 && value.dropFirst(16).hasPrefix("2f12") ? value : nil
    }.first)
    return try XCTUnwrap(Data(hexString: hex))
}

extension Data {
    init?(hexString: String) {
        let byteCount = hexString.count / 2
        var data = Data(capacity: byteCount)
        var index = hexString.startIndex
        for _ in 0..<byteCount {
            let nextIndex = hexString.index(index, offsetBy: 2)
            guard let byte = UInt8(hexString[index..<nextIndex], radix: 16) else { return nil }
            data.append(byte)
            index = nextIndex
        }
        self = data
    }
}

func makeRealtimeSample(timestampSeconds: UInt32) -> WhoopRealtimeDataSample {
    WhoopRealtimeDataSample(
        timestampSeconds: timestampSeconds,
        subSeconds: 0,
        heartRate: 60,
        rrIntervalMs: 1_000,
        quaternionW: 1,
        quaternionX: 0,
        quaternionY: 0,
        quaternionZ: 0,
        opticalBytes: Data(count: 18)
    )
}
