import XCTest
@testable import SleepWidgetLib

final class SleepWidgetSnapshotWriterTests: XCTestCase {
    private var container: URL!

    override func setUpWithError() throws {
        try super.setUpWithError()
        container = FileManager.default.temporaryDirectory
            .appendingPathComponent("sleep-widget-writer-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: container, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: container)
        container = nil
        try super.tearDownWithError()
    }

    func testAppGroupIdentifierUsesHostBundle() {
        XCTAssertEqual(
            SleepWidgetSnapshotWriter.appGroupIdentifier(hostBundleIdentifier: "com.dofek.app"),
            "group.com.dofek.app.sleep-widget"
        )
        XCTAssertEqual(
            SleepWidgetSnapshotWriter.appGroupIdentifier(hostBundleIdentifier: "com.dofek.app.preview"),
            "group.com.dofek.app.preview.sleep-widget"
        )
    }

    func testReplaceSnapshotWritesSkipsUnchangedAndRemoves() throws {
        let payload = #"{"version":1,"kind":"signedOut"}"#
        let destination = SleepWidgetSnapshotWriter.snapshotURL(containerURL: container)

        XCTAssertTrue(
            try SleepWidgetSnapshotWriter.replaceSnapshot(payload, containerURL: container)
        )
        XCTAssertEqual(try String(contentsOf: destination, encoding: .utf8), payload)

        XCTAssertFalse(
            try SleepWidgetSnapshotWriter.replaceSnapshot(payload, containerURL: container)
        )

        let updated = #"{"version":1,"kind":"empty","expiresAt":1795593600000}"#
        XCTAssertTrue(
            try SleepWidgetSnapshotWriter.replaceSnapshot(updated, containerURL: container)
        )
        XCTAssertEqual(try String(contentsOf: destination, encoding: .utf8), updated)

        XCTAssertTrue(
            try SleepWidgetSnapshotWriter.replaceSnapshot(nil, containerURL: container)
        )
        XCTAssertFalse(FileManager.default.fileExists(atPath: destination.path))

        XCTAssertFalse(
            try SleepWidgetSnapshotWriter.replaceSnapshot(nil, containerURL: container)
        )
    }

    func testNilSnapshotTreatsMissingFileAsUnchanged() throws {
        XCTAssertFalse(
            try SleepWidgetSnapshotWriter.replaceSnapshot(nil, containerURL: container)
        )
    }

    func testNilSnapshotPropagatesNonAbsenceRemovalFailures() {
        let failingManager = RemovalFailingFileManager()
        XCTAssertThrowsError(
            try SleepWidgetSnapshotWriter.replaceSnapshot(
                nil,
                containerURL: container,
                fileManager: failingManager
            )
        ) { error in
            XCTAssertEqual(error as? SleepWidgetSnapshotWriter.WriterError, .writeFailed)
        }
    }
}

private final class RemovalFailingFileManager: FileManager, @unchecked Sendable {
    override func removeItem(at URL: URL) throws {
        throw NSError(
            domain: NSCocoaErrorDomain,
            code: CocoaError.fileWriteNoPermission.rawValue
        )
    }
}
