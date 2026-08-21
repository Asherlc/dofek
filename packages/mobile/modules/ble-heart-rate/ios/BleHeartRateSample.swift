import Foundation

/// A single heart-rate notification captured from a Bluetooth strap.
///
/// The timestamp is assigned when the notification is received on the phone —
/// standard Heart Rate Measurement notifications do not carry their own clock.
struct BleHeartRateSample {
    let deviceId: String
    let timestamp: Date
    let heartRateBpm: Int
    let rrIntervalsMs: [Int]
}
