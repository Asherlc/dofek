import XCTest
@testable import WhoopBLE

final class WhoopBleBackgroundUploaderStartupTests: XCTestCase {
    func testStartupReconciliationReportsBodyDirectoryListingFailure() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        addTeardownBlock { try FileManager.default.removeItem(at: directory) }
        let store = try WhoopBleSampleStore(directory: directory)
        let bodies = directory.appendingPathComponent("bodies", isDirectory: true)
        let backup = directory.appendingPathComponent("bodies-backup", isDirectory: true)
        let transport = TestWhoopUploadTransport()
        let reported = expectation(description: "Startup reconciliation reports the body directory error")
        let errorLock = NSLock()
        var errors: [Error] = []
        transport.beforeAllTasks = {
            transport.beforeAllTasks = nil
            do {
                try FileManager.default.moveItem(at: bodies, to: backup)
                try Data().write(to: bodies)
            } catch {
                XCTFail("Could not install controlled body directory failure: \(error)")
            }
        }
        let uploader = try WhoopBleBackgroundUploader(
            store: store, directory: bodies, transport: transport, reportError: { error in
                errorLock.lock()
                errors.append(error)
                errorLock.unlock()
                reported.fulfill()
            }
        )

        wait(for: [reported], timeout: 5)
        errorLock.lock()
        let capturedErrors = errors
        errorLock.unlock()
        XCTAssertEqual(capturedErrors.count, 1)
        XCTAssertTrue(capturedErrors.first?.localizedDescription.contains("bodies") == true)

        try FileManager.default.removeItem(at: bodies)
        try FileManager.default.moveItem(at: backup, to: bodies)
        try uploader.disable()
    }
}

extension WhoopBleBackgroundUploaderTests {
    func testBackgroundCompletionWaitsForNextEligibleTask() throws {
        let (uploader, _, transport) = try setup()
        try uploader.append(deviceId: "a", samplesByStream: [.realtime: Array(repeating: rows[0], count: 1_000)])
        try uploader.flush(); try settle(uploader)
        XCTAssertEqual(transport.requests.count, 1)

        let handoff = expectation(description: "Next task reconciliation requested")
        let completion = expectation(description: "Background events finish after handoff")
        let mainQueueDrained = expectation(description: "Earlier main queue callbacks have run")
        var releaseSnapshot: (() -> Void)?
        transport.holdTaskSnapshot = { release in
            transport.holdTaskSnapshot = nil
            releaseSnapshot = release
            handoff.fulfill()
        }
        uploader.handleBackgroundEvents {
            XCTAssertEqual(transport.requests.count, 2)
            completion.fulfill()
        }
        transport.complete(0)
        transport.onFinishEvents?()
        wait(for: [handoff], timeout: 2)
        try settle(uploader)
        DispatchQueue.main.async { mainQueueDrained.fulfill() }
        wait(for: [mainQueueDrained], timeout: 2)
        try XCTUnwrap(releaseSnapshot)()
        wait(for: [completion], timeout: 2)
    }
}
