import Foundation

/// A quaternion representing 3D orientation.
struct Quaternion {
    var w: Double
    var x: Double
    var y: Double
    var z: Double

    static let identity = Quaternion(w: 1, x: 0, y: 0, z: 0)
}

/// Euler angles in degrees.
struct EulerAngles {
    let roll: Double   // rotation around X (-180..180)
    let pitch: Double  // rotation around Y (-90..90)
    let yaw: Double    // rotation around Z (-180..180)
}

/// Madgwick AHRS (Attitude and Heading Reference System) filter.
///
/// Fuses 6-axis IMU data (accelerometer + gyroscope) into a quaternion
/// representing the sensor's 3D orientation. Uses gradient descent to
/// correct gyroscope drift using the accelerometer's gravity reference.
///
/// Reference: Sebastian Madgwick, "An efficient orientation filter for
/// inertial and inertial/magnetic sensor arrays" (2010).
///
/// This implementation accepts pre-normalized sensor values:
/// - Accelerometer: in g (1g = Earth gravity)
/// - Gyroscope: in rad/s
final class MadgwickFilter {

    private static let radiansToDegrees: Double = 180.0 / .pi

    /// Current orientation estimate
    private(set) var quaternion: Quaternion = .identity

    /// Filter gain — controls how aggressively the accelerometer corrects
    /// gyroscope drift. Higher = faster convergence but more noise sensitivity.
    /// Typical range: 0.01 (smooth) to 0.5 (aggressive).
    let beta: Double

    /// Time between samples in seconds (1 / sampleRate)
    let samplePeriod: Double

    init(sampleRate: Double, beta: Double = 0.1) {
        self.samplePeriod = 1.0 / sampleRate
        self.beta = beta
    }

    /// Reset orientation to identity quaternion.
    func reset() {
        quaternion = .identity
    }

    /// Feed a new IMU sample with pre-normalized values.
    /// - accelerometerX/Y/Z: acceleration in g (1g = Earth gravity)
    /// - gyroscopeX/Y/Z: rotation rate in rad/s
    func update(
        accelerometerX: Float, accelerometerY: Float, accelerometerZ: Float,
        gyroscopeX: Float, gyroscopeY: Float, gyroscopeZ: Float
    ) {
        var ax = Double(accelerometerX)
        var ay = Double(accelerometerY)
        var az = Double(accelerometerZ)

        let gx = Double(gyroscopeX)
        let gy = Double(gyroscopeY)
        let gz = Double(gyroscopeZ)

        var q0 = quaternion.w
        var q1 = quaternion.x
        var q2 = quaternion.y
        var q3 = quaternion.z

        // Gyroscope quaternion derivative
        let qDot0 = 0.5 * (-q1 * gx - q2 * gy - q3 * gz)
        let qDot1 = 0.5 * ( q0 * gx + q2 * gz - q3 * gy)
        let qDot2 = 0.5 * ( q0 * gy - q1 * gz + q3 * gx)
        let qDot3 = 0.5 * ( q0 * gz + q1 * gy - q2 * gx)

        // Accelerometer correction (only if accelerometer data is valid)
        let accelNorm = sqrt(ax * ax + ay * ay + az * az)
        if accelNorm > 0.01 {
            // Normalize accelerometer
            ax /= accelNorm
            ay /= accelNorm
            az /= accelNorm

            // Gradient descent objective function components
            let f0 = 2.0 * (q1 * q3 - q0 * q2) - ax
            let f1 = 2.0 * (q0 * q1 + q2 * q3) - ay
            let f2 = 2.0 * (0.5 - q1 * q1 - q2 * q2) - az

            // Jacobian transpose times f (gradient step direction)
            var s0 = -2.0 * q2 * f0 + 2.0 * q1 * f1
            var s1 =  2.0 * q3 * f0 + 2.0 * q0 * f1 - 4.0 * q1 * f2
            var s2 = -2.0 * q0 * f0 + 2.0 * q3 * f1 - 4.0 * q2 * f2
            var s3 =  2.0 * q1 * f0 + 2.0 * q2 * f1

            // Normalize step
            let stepNorm = sqrt(s0 * s0 + s1 * s1 + s2 * s2 + s3 * s3)
            if stepNorm > 0 {
                s0 /= stepNorm
                s1 /= stepNorm
                s2 /= stepNorm
                s3 /= stepNorm
            }

            // Apply feedback (gyro rate - beta * gradient)
            q0 += (qDot0 - beta * s0) * samplePeriod
            q1 += (qDot1 - beta * s1) * samplePeriod
            q2 += (qDot2 - beta * s2) * samplePeriod
            q3 += (qDot3 - beta * s3) * samplePeriod
        } else {
            // No valid accel data — pure gyro integration
            q0 += qDot0 * samplePeriod
            q1 += qDot1 * samplePeriod
            q2 += qDot2 * samplePeriod
            q3 += qDot3 * samplePeriod
        }

        // Normalize quaternion
        let norm = sqrt(q0 * q0 + q1 * q1 + q2 * q2 + q3 * q3)
        if norm > 0 {
            quaternion = Quaternion(
                w: q0 / norm,
                x: q1 / norm,
                y: q2 / norm,
                z: q3 / norm
            )
        }
    }

    /// Convert the current quaternion to Euler angles (degrees).
    ///
    /// Uses ZYX (aerospace) convention:
    /// - Roll: rotation around X axis (-180..180°)
    /// - Pitch: rotation around Y axis (-90..90°)
    /// - Yaw: rotation around Z axis (-180..180°)
    var eulerAngles: EulerAngles {
        let w = quaternion.w
        let x = quaternion.x
        let y = quaternion.y
        let z = quaternion.z

        // Roll (X-axis rotation)
        let sinRollCosPitch = 2.0 * (w * x + y * z)
        let cosRollCosPitch = 1.0 - 2.0 * (x * x + y * y)
        let roll = atan2(sinRollCosPitch, cosRollCosPitch) * MadgwickFilter.radiansToDegrees

        // Pitch (Y-axis rotation) — clamped to avoid NaN at poles
        let sinPitch = 2.0 * (w * y - z * x)
        let pitch: Double
        if abs(sinPitch) >= 1 {
            pitch = copysign(90.0, sinPitch)
        } else {
            pitch = asin(sinPitch) * MadgwickFilter.radiansToDegrees
        }

        // Yaw (Z-axis rotation)
        let sinYawCosPitch = 2.0 * (w * z + x * y)
        let cosYawCosPitch = 1.0 - 2.0 * (y * y + z * z)
        let yaw = atan2(sinYawCosPitch, cosYawCosPitch) * MadgwickFilter.radiansToDegrees

        return EulerAngles(roll: roll, pitch: pitch, yaw: yaw)
    }
}
