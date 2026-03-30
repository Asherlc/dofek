import XCTest
@testable import WhoopBleLib

final class MadgwickFilterTests: XCTestCase {

    // MARK: - Initial state

    func testInitialQuaternionIsIdentity() {
        let filter = MadgwickFilter(sampleRate: 100)
        let quaternion = filter.quaternion

        XCTAssertEqual(quaternion.w, 1.0, accuracy: 1e-6)
        XCTAssertEqual(quaternion.x, 0.0, accuracy: 1e-6)
        XCTAssertEqual(quaternion.y, 0.0, accuracy: 1e-6)
        XCTAssertEqual(quaternion.z, 0.0, accuracy: 1e-6)
    }

    func testQuaternionIsNormalized() {
        let filter = MadgwickFilter(sampleRate: 100)
        let quaternion = filter.quaternion
        let norm = sqrt(
            quaternion.w * quaternion.w +
            quaternion.x * quaternion.x +
            quaternion.y * quaternion.y +
            quaternion.z * quaternion.z
        )
        XCTAssertEqual(norm, 1.0, accuracy: 1e-6)
    }

    // MARK: - Stationary (gravity only)

    func testStationaryWithGravityAlongZConverges() {
        // Accelerometer reads [0, 0, 1g] — device is flat, Z-up
        let filter = MadgwickFilter(sampleRate: 100, beta: 0.1)

        // Feed 200 samples (2 seconds) of stationary data
        for _ in 0..<200 {
            filter.update(
                accelerometerX: 0, accelerometerY: 0, accelerometerZ: 4096,
                gyroscopeX: 0, gyroscopeY: 0, gyroscopeZ: 0
            )
        }

        // Should converge to identity quaternion (no rotation from reference)
        let quaternion = filter.quaternion
        let norm = sqrt(
            quaternion.w * quaternion.w +
            quaternion.x * quaternion.x +
            quaternion.y * quaternion.y +
            quaternion.z * quaternion.z
        )
        XCTAssertEqual(norm, 1.0, accuracy: 1e-4, "Quaternion must stay normalized")

        // Euler angles should be near zero
        let euler = filter.eulerAngles
        XCTAssertEqual(euler.roll, 0, accuracy: 5, "Roll should be ~0 degrees")
        XCTAssertEqual(euler.pitch, 0, accuracy: 5, "Pitch should be ~0 degrees")
    }

    func testStationaryWithGravityAlongNegativeYConverges() {
        // Accelerometer reads [0, -1g, 0] — device on its side, gravity along -Y
        // This corresponds to a 90° roll. Higher beta for faster convergence.
        let filter = MadgwickFilter(sampleRate: 100, beta: 0.5)

        for _ in 0..<1000 {
            filter.update(
                accelerometerX: 0, accelerometerY: -4096, accelerometerZ: 0,
                gyroscopeX: 0, gyroscopeY: 0, gyroscopeZ: 0
            )
        }

        let euler = filter.eulerAngles
        // Should converge to ~90° roll (or -90° depending on convention)
        XCTAssertEqual(abs(euler.roll), 90, accuracy: 5, "Roll should be ~±90 degrees")
    }

    // MARK: - Gyroscope integration

    func testGyroRotationChangesOrientation() {
        let filter = MadgwickFilter(sampleRate: 100, beta: 0.0) // beta=0: pure gyro integration

        let initialQuaternion = filter.quaternion

        // Rotate around Z axis at 100 deg/s for 0.5 seconds
        // Gyro raw value for 100 dps at ±2000dps/16.4 LSB: 100 * 16.4 = 1640 LSB
        let gyroZ: Int16 = 1640
        for _ in 0..<50 {
            filter.update(
                accelerometerX: 0, accelerometerY: 0, accelerometerZ: 4096,
                gyroscopeX: 0, gyroscopeY: 0, gyroscopeZ: gyroZ
            )
        }

        let finalQuaternion = filter.quaternion

        // Orientation should have changed
        let dotProduct = initialQuaternion.w * finalQuaternion.w +
            initialQuaternion.x * finalQuaternion.x +
            initialQuaternion.y * finalQuaternion.y +
            initialQuaternion.z * finalQuaternion.z

        XCTAssertLessThan(abs(dotProduct), 0.99, "Quaternion should have rotated significantly")

        // Yaw should be approximately 50° (100 deg/s * 0.5s)
        let euler = filter.eulerAngles
        XCTAssertEqual(euler.yaw, 50, accuracy: 10, "Yaw should be ~50 degrees")
    }

    // MARK: - Quaternion stays normalized under sustained input

    func testQuaternionStaysNormalizedUnderRotation() {
        let filter = MadgwickFilter(sampleRate: 100, beta: 0.05)

        // Simulate tumbling motion — all axes active
        for index in 0..<1000 {
            let phase = Double(index) * 0.1
            filter.update(
                accelerometerX: Int16(2000 * sin(phase)),
                accelerometerY: Int16(2000 * cos(phase)),
                accelerometerZ: Int16(3000 + 1000 * sin(phase * 0.7)),
                gyroscopeX: Int16(500 * sin(phase * 1.3)),
                gyroscopeY: Int16(500 * cos(phase * 0.9)),
                gyroscopeZ: Int16(300 * sin(phase * 1.1))
            )

            let quaternion = filter.quaternion
            let norm = sqrt(
                quaternion.w * quaternion.w +
                quaternion.x * quaternion.x +
                quaternion.y * quaternion.y +
                quaternion.z * quaternion.z
            )
            XCTAssertEqual(norm, 1.0, accuracy: 1e-3, "Quaternion must stay normalized at step \(index)")
        }
    }

    // MARK: - Raw-to-SI conversion

    func testAccelerometerConversion() {
        // ±8g range: 4096 LSB/g
        // 4096 raw → 1.0g → 9.81 m/s²
        let gravityMetersPerSecondSquared = MadgwickFilter.convertAccelerometer(raw: 4096)
        XCTAssertEqual(gravityMetersPerSecondSquared, 9.81, accuracy: 0.01)

        let zeroG = MadgwickFilter.convertAccelerometer(raw: 0)
        XCTAssertEqual(zeroG, 0.0, accuracy: 0.001)
    }

    func testGyroscopeConversion() {
        // ±2000 dps: 16.4 LSB/dps
        // 16.4 raw → 1.0 dps → π/180 rad/s
        let oneDegrePerSecond = MadgwickFilter.convertGyroscope(raw: 16)
        XCTAssertEqual(oneDegrePerSecond, Double.pi / 180, accuracy: 0.01)
    }

    // MARK: - Euler angle ranges

    func testEulerAnglesInExpectedRanges() {
        let filter = MadgwickFilter(sampleRate: 100, beta: 0.1)

        // Feed some arbitrary orientation data
        for _ in 0..<100 {
            filter.update(
                accelerometerX: 2000, accelerometerY: -1000, accelerometerZ: 3500,
                gyroscopeX: 100, gyroscopeY: -200, gyroscopeZ: 50
            )
        }

        let euler = filter.eulerAngles
        XCTAssertGreaterThanOrEqual(euler.roll, -180)
        XCTAssertLessThanOrEqual(euler.roll, 180)
        XCTAssertGreaterThanOrEqual(euler.pitch, -90)
        XCTAssertLessThanOrEqual(euler.pitch, 90)
        XCTAssertGreaterThanOrEqual(euler.yaw, -180)
        XCTAssertLessThanOrEqual(euler.yaw, 180)
    }

    // MARK: - Reset

    func testResetRestoresIdentity() {
        let filter = MadgwickFilter(sampleRate: 100, beta: 0.1)

        // Move away from identity
        for _ in 0..<100 {
            filter.update(
                accelerometerX: 2000, accelerometerY: -3000, accelerometerZ: 1000,
                gyroscopeX: 500, gyroscopeY: -300, gyroscopeZ: 800
            )
        }

        // Verify we're not at identity
        XCTAssertNotEqual(filter.quaternion.w, 1.0, accuracy: 0.01)

        filter.reset()

        let quaternion = filter.quaternion
        XCTAssertEqual(quaternion.w, 1.0, accuracy: 1e-6)
        XCTAssertEqual(quaternion.x, 0.0, accuracy: 1e-6)
        XCTAssertEqual(quaternion.y, 0.0, accuracy: 1e-6)
        XCTAssertEqual(quaternion.z, 0.0, accuracy: 1e-6)
    }
}
