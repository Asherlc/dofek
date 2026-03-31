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
                accelerometerX: 0, accelerometerY: 0, accelerometerZ: 1.0,
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
                accelerometerX: 0, accelerometerY: -1.0, accelerometerZ: 0,
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
        // 100 dps in rad/s = 100 * π/180 ≈ 1.7453
        let gyroZ: Float = 100.0 * .pi / 180.0
        for _ in 0..<50 {
            filter.update(
                accelerometerX: 0, accelerometerY: 0, accelerometerZ: 1.0,
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

        // Simulate tumbling motion — all axes active (values in g and rad/s)
        for index in 0..<1000 {
            let phase = Double(index) * 0.1
            filter.update(
                accelerometerX: Float(0.5 * sin(phase)),
                accelerometerY: Float(0.5 * cos(phase)),
                accelerometerZ: Float(0.75 + 0.25 * sin(phase * 0.7)),
                gyroscopeX: Float(0.5 * sin(phase * 1.3)),
                gyroscopeY: Float(0.5 * cos(phase * 0.9)),
                gyroscopeZ: Float(0.3 * sin(phase * 1.1))
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

    // MARK: - Euler angle ranges

    func testEulerAnglesInExpectedRanges() {
        let filter = MadgwickFilter(sampleRate: 100, beta: 0.1)

        // Feed some arbitrary orientation data (values in g and rad/s)
        for _ in 0..<100 {
            filter.update(
                accelerometerX: 0.49, accelerometerY: -0.24, accelerometerZ: 0.85,
                gyroscopeX: 0.106, gyroscopeY: -0.213, gyroscopeZ: 0.053
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

        // Move away from identity (values in g and rad/s)
        for _ in 0..<100 {
            filter.update(
                accelerometerX: 0.49, accelerometerY: -0.73, accelerometerZ: 0.24,
                gyroscopeX: 0.53, gyroscopeY: -0.32, gyroscopeZ: 0.85
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
