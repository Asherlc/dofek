import Foundation

/// A validated complete frame plus the existing parsed header fields.
struct WhoopFrame {
    let packetType: UInt8
    let recordType: UInt8
    let dataTimestamp: UInt32
    let subSeconds: UInt16
    let payload: Data
    let rawData: Data

    init(packetType: UInt8, recordType: UInt8, dataTimestamp: UInt32, subSeconds: UInt16,
         payload: Data, rawData: Data = Data()) {
        self.packetType = packetType; self.recordType = recordType
        self.dataTimestamp = dataTimestamp; self.subSeconds = subSeconds
        self.payload = payload; self.rawData = rawData
    }
}
