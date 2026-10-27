import Foundation

/// Converts barometric pressure readings into relative altitude changes.
///
/// Uses the international barometric formula rather than `CMAltitudeData.relativeAltitude`,
/// which can report erroneous spikes when a workout session is paused.
enum AltitudeCalculator {
    private static let barometricExponent = 0.190294 // 1 / 5.255

    /// Relative altitude change in meters from a pressure reading vs a session baseline.
    static func relativeAltitudeMeters(pressureKPa: Double, baselinePressureKPa: Double) -> Double {
        guard baselinePressureKPa > 0, pressureKPa > 0 else { return 0 }
        let ratio = pressureKPa / baselinePressureKPa
        return 44330.0 * (1.0 - pow(ratio, barometricExponent))
    }
}
