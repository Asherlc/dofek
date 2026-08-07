import CoreBluetooth

/// Bluetooth SIG assigned numbers for the standard Heart Rate Service.
///
/// - Heart Rate Service: 0x180D
/// - Heart Rate Measurement characteristic: 0x2A37 (notify)
///
/// Reference: Bluetooth SIG "Heart Rate Service 1.0" and "GATT Specification
/// Supplement" (https://www.bluetooth.com/specifications/specs/heart-rate-service-1-0/).
enum BleHeartRateConstants {
    /// Heart Rate Service (0x180D).
    static let heartRateServiceUUID = CBUUID(string: "180D")

    /// Heart Rate Measurement characteristic (0x2A37).
    static let heartRateMeasurementUUID = CBUUID(string: "2A37")
}
