import HealthKit
import XCTest

@testable import HealthKitLib

private final class WorkoutSource: HKSource, @unchecked Sendable {
    override var name: String { "Fitness" }
    override var bundleIdentifier: String { "com.apple.fitness" }
}

private final class RecordedWorkout: HKWorkout, @unchecked Sendable {
    private var recordedSourceRevision: HKSourceRevision?
    private var recordedActivities: [HKWorkoutActivity] = []

    override var sourceRevision: HKSourceRevision {
        guard let recordedSourceRevision else {
            preconditionFailure("Construct workout fixtures with RecordedWorkout.make")
        }
        return recordedSourceRevision
    }
    override var workoutActivities: [HKWorkoutActivity] { recordedActivities }

    static func make(device: HKDevice? = nil, activities: [HKWorkoutActivity] = []) throws -> RecordedWorkout {
        // SwiftPM has no app bundle, so decode a test source and override its public identity.
        let archiver = NSKeyedArchiver(requiringSecureCoding: true)
        archiver.finishEncoding()
        let decoder = try NSKeyedUnarchiver(forReadingFrom: archiver.encodedData)
        defer { decoder.finishDecoding() }
        let source = try XCTUnwrap(WorkoutSource(coder: decoder))
        let revision = HKSourceRevision(
            source: source, version: "1.0", productType: "Watch7,12",
            operatingSystemVersion: OperatingSystemVersion(majorVersion: 26, minorVersion: 0, patchVersion: 0)
        )
        let workout = RecordedWorkout(activityType: .running, start: Date(), end: Date(), duration: 0,
                                      totalEnergyBurned: nil, totalDistance: nil, device: device, metadata: nil)
        workout.recordedSourceRevision = revision
        workout.recordedActivities = activities
        return workout
    }
}

final class HealthKitWorkoutTransportTests: XCTestCase {
    func testWorkoutTransportRetainsSourceProductTypeSeparatelyFromGenericDeviceModel() throws {
        let workout = try RecordedWorkout.make(
            device: HKDevice(name: "My Watch", manufacturer: "Apple", model: "Watch",
                             hardwareVersion: nil, firmwareVersion: nil, softwareVersion: nil,
                             localIdentifier: nil, udiDeviceIdentifier: nil)
        )
        let result = HealthKitWorkoutTransport.encode(workout)
        XCTAssertEqual(result["sourceProductType"] as? String, "Watch7,12")
        XCTAssertEqual((result["device"] as? [String: String])?["model"], "Watch")
        XCTAssertNil(result["workoutActivities"])
    }

    func testWorkoutTransportPreservesReportedDeviceAndSource() throws {
        let device = HKDevice(
            name: "My Watch", manufacturer: "Apple", model: "Watch7,12",
            hardwareVersion: "2", firmwareVersion: "3", softwareVersion: "11.0",
            localIdentifier: "local-device", udiDeviceIdentifier: "udi-device"
        )
        let workout = HKWorkout(
            activityType: .running,
            start: Date(timeIntervalSince1970: 1_700_000_000),
            end: Date(timeIntervalSince1970: 1_700_000_060),
            duration: 60, totalEnergyBurned: nil, totalDistance: HKQuantity(unit: .meter(), doubleValue: 200),
            device: device, metadata: [
                "recordedBy": "runner", "recordingVersion": 3,
                "recordingDate": Date(timeIntervalSince1970: 1_700_000_000),
            ]
        )
        let result = HealthKitWorkoutTransport.encode(workout)
        let hardware = try XCTUnwrap(result["device"] as? [String: String])
        XCTAssertEqual(hardware, [
            "name": "My Watch", "manufacturer": "Apple", "model": "Watch7,12",
            "hardwareVersion": "2", "firmwareVersion": "3", "softwareVersion": "11.0",
            "localIdentifier": "local-device", "udiDeviceIdentifier": "udi-device",
        ])
        XCTAssertEqual(result["sourceName"] as? String, workout.sourceRevision.source.name)
        XCTAssertEqual(result["sourceBundle"] as? String, workout.sourceRevision.source.bundleIdentifier)
        XCTAssertEqual(result["uuid"] as? String, workout.uuid.uuidString)
        XCTAssertEqual(result["workoutType"] as? String, String(HKWorkoutActivityType.running.rawValue))
        XCTAssertEqual(result["startDate"] as? String, HealthKitQueries.formatDate(workout.startDate))
        XCTAssertEqual(result["endDate"] as? String, HealthKitQueries.formatDate(workout.endDate))
        XCTAssertEqual(result["duration"] as? Double, 60)
        XCTAssertEqual(result["totalDistance"] as? Double, 200)
        let metadata = try XCTUnwrap(result["metadata"] as? [String: Any])
        XCTAssertEqual(metadata["recordedBy"] as? String, "runner")
        XCTAssertEqual(metadata["recordingVersion"] as? Double, 3)
        XCTAssertEqual(metadata["recordingDate"] as? String, HealthKitQueries.formatDate(workout.startDate))
    }

    func testWorkoutWithPartialDeviceKeepsUnknownFieldsAbsent() throws {
        let device = HKDevice(name: nil, manufacturer: nil, model: "Watch", hardwareVersion: nil,
                              firmwareVersion: nil, softwareVersion: nil, localIdentifier: nil,
                              udiDeviceIdentifier: nil)
        let workout = HKWorkout(activityType: .walking, start: Date(), end: Date(), duration: 0,
                                totalEnergyBurned: nil, totalDistance: nil, device: device, metadata: nil)
        XCTAssertEqual(HealthKitWorkoutTransport.encode(workout)["device"] as? [String: String], ["model": "Watch"])
    }

    func testWorkoutActivitiesPreserveDatesAndJSONSafeMetadata() throws {
        let start = Date(timeIntervalSince1970: 1_700_000_000)
        let end = start.addingTimeInterval(60)
        let configuration = HKWorkoutConfiguration()
        configuration.activityType = .running
        let activity = HKWorkoutActivity(workoutConfiguration: configuration, start: start, end: end, metadata: [
            "label": "run", "version": 2, "recordedAt": start,
            "unsupported": HKQuantity(unit: .meter(), doubleValue: 1),
        ])
        let ongoing = HKWorkoutActivity(workoutConfiguration: configuration, start: end, end: nil, metadata: nil)
        let workout = try RecordedWorkout.make(activities: [activity, ongoing])

        let result = HealthKitWorkoutTransport.encode(workout)
        let activities = try XCTUnwrap(result["workoutActivities"] as? [[String: Any]])
        XCTAssertEqual(activities.count, 2)
        XCTAssertEqual(activities[0]["uuid"] as? String, activity.uuid.uuidString)
        XCTAssertEqual(activities[0]["activityType"] as? UInt, HKWorkoutActivityType.running.rawValue)
        XCTAssertEqual(activities[0]["startDate"] as? String, HealthKitQueries.formatDate(start))
        XCTAssertEqual(activities[0]["endDate"] as? String, HealthKitQueries.formatDate(end))
        let metadata = try XCTUnwrap(activities[0]["metadata"] as? [String: Any])
        XCTAssertEqual(metadata["label"] as? String, "run")
        XCTAssertEqual(metadata["version"] as? Double, 2)
        XCTAssertEqual(metadata["recordedAt"] as? String, HealthKitQueries.formatDate(start))
        XCTAssertNil(metadata["unsupported"])
        XCTAssertEqual(activities[1]["startDate"] as? String, HealthKitQueries.formatDate(end))
        XCTAssertNil(activities[1]["endDate"])
        XCTAssertNil(activities[1]["metadata"])
    }

    func testWorkoutOmitsUnknownFactsAndUnbridgeableMetadata() {
        let workout = HKWorkout(activityType: .walking, start: Date(), end: Date(), duration: 0,
                                totalEnergyBurned: nil, totalDistance: nil, metadata: [
                                    "unsupported": HKQuantity(unit: .meter(), doubleValue: 1),
                                ])
        let result = HealthKitWorkoutTransport.encode(workout)

        XCTAssertNil(result["device"])
        XCTAssertNil(result["sourceProductType"])
        XCTAssertNil(result["totalDistance"])
        XCTAssertNil(result["metadata"])
    }
}
