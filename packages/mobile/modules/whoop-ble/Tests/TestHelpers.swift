import Foundation
@testable import WhoopBLE

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

// MARK: - WHOOP buffer sample fixtures

func makeImuSamples(count: Int) -> [WhoopImuSample] {
    (0..<count).map { index in
        WhoopImuSample(
            timestampSeconds: 1711000000,
            subSeconds: UInt16(index * 10),
            sampleIndex: index,
            samplesInFrame: count,
            accelerometerX: Float(index) * 0.1,
            accelerometerY: 0,
            accelerometerZ: 1.0,
            gyroscopeX: 0,
            gyroscopeY: 0,
            gyroscopeZ: 0
        )
    }
}

func makeImuSample(timestampSeconds: UInt32) -> WhoopImuSample {
    WhoopImuSample(
        timestampSeconds: timestampSeconds,
        subSeconds: 0,
        sampleIndex: 0,
        samplesInFrame: 1,
        accelerometerX: 0,
        accelerometerY: 0,
        accelerometerZ: 1,
        gyroscopeX: 0,
        gyroscopeY: 0,
        gyroscopeZ: 0
    )
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

func makeRealtimeSamples(count: Int) -> [WhoopRealtimeDataSample] {
    var samples: [WhoopRealtimeDataSample] = []
    for index in 0..<count {
        let sample = WhoopRealtimeDataSample(
            timestampSeconds: 1711000000 + UInt32(index),
            subSeconds: 0,
            heartRate: UInt8(60 + index),
            rrIntervalMs: UInt16(900 + index * 10),
            quaternionW: 1.0,
            quaternionX: 0,
            quaternionY: 0,
            quaternionZ: 0,
            opticalBytes: Data(count: 18)
        )
        samples.append(sample)
    }
    return samples
}

func makeImuSamplesForOverflow(count: Int, startingAt startIndex: Int) -> [WhoopImuSample] {
    (startIndex..<(startIndex + count)).map { index in
        WhoopImuSample(
            timestampSeconds: 1711000000,
            subSeconds: 0,
            sampleIndex: 0,
            samplesInFrame: 100,
            accelerometerX: Float(index),
            accelerometerY: 0,
            accelerometerZ: 1.0,
            gyroscopeX: 0,
            gyroscopeY: 0,
            gyroscopeZ: 0
        )
    }
}

func makeRealtimeSamplesForOverflow(count: Int, startingAt startIndex: Int) -> [WhoopRealtimeDataSample] {
    let indices = startIndex..<(startIndex + count)
    return indices.map { index in
        let timestampSeconds = UInt32(1_711_000_000 + index)
        let heartRate = UInt8(60 + index % 50)
        let rrIntervalMs = UInt16(900 + index % 1_000)
        return WhoopRealtimeDataSample(
            timestampSeconds: timestampSeconds,
            subSeconds: 0,
            heartRate: heartRate,
            rrIntervalMs: rrIntervalMs,
            quaternionW: 1.0,
            quaternionX: 0,
            quaternionY: 0,
            quaternionZ: 0,
            opticalBytes: Data(count: 18)
        )
    }
}
