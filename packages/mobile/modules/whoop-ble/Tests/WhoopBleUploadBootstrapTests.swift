import Foundation
import XCTest
@testable import WhoopBLE

private final class BootstrapTransport: WhoopUploadTransport {
    var onCompletion: ((String, Int?, Data, URL?, Error?) -> Void)?
    var onFinishEvents: (() -> Void)?
    func allTasks(_ completion: @escaping ([String]) -> Void) { completion([]) }
    func start(request: URLRequest, file: URL, identity: String) {}
    func cancel(identity: String) {}
}

final class WhoopBleUploadBootstrapTests: XCTestCase {
    private struct OpenError: Error {}

    private func uploader() throws -> (WhoopBleBackgroundUploader, BootstrapTransport) {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let store = try WhoopBleSampleStore(directory: directory)
        let transport = BootstrapTransport()
        let service = try WhoopBleBackgroundUploader(
            store: store, directory: directory.appendingPathComponent("bodies"),
            transport: transport, reportError: { XCTFail("Unexpected upload error: \($0)") }
        )
        addTeardownBlock {
            // Drain reconciliation/delegate work before removing its files.
            for _ in 0..<4 { _ = try service.diagnostics() }
            try FileManager.default.removeItem(at: directory)
        }
        return (service, transport)
    }

    func testLifecycleAttachmentReturnsWhileInitializationIsBlocked() throws {
        let (service, transport) = try uploader()
        let entered = expectation(description: "Factory entered")
        let completed = expectation(description: "OS completion")
        let release = DispatchSemaphore(value: 0)
        let bootstrap = WhoopBleUploadBootstrap(makeUploader: {
            XCTAssertFalse(Thread.isMainThread)
            entered.fulfill()
            XCTAssertEqual(release.wait(timeout: .now() + 2), .success)
            return service
        }, reportError: { XCTFail("Unexpected bootstrap error: \($0)") })
        bootstrap.prepare { XCTFail("Unexpected preparation error: \($0)") }
        wait(for: [entered], timeout: 2)
        // The release is queued on main: a synchronous lifecycle call would block it.
        DispatchQueue.main.async { release.signal() }
        bootstrap.handleBackgroundEvents {
            XCTAssertTrue(Thread.isMainThread)
            completed.fulfill()
        }
        transport.onFinishEvents?()
        wait(for: [completed], timeout: 2)
        XCTAssertTrue(try bootstrap.shared() === service)
    }

    func testConcurrentConsumersShareOneSuccessfulInitialization() throws {
        let (service, _) = try uploader()
        let consumers = expectation(description: "All consumers")
        consumers.expectedFulfillmentCount = 12
        var creations = 0
        let bootstrap = WhoopBleUploadBootstrap(makeUploader: {
            creations += 1
            return service
        }, reportError: { XCTFail("Unexpected bootstrap error: \($0)") })
        bootstrap.prepare { XCTFail("Unexpected preparation error: \($0)") }
        for _ in 0..<12 {
            DispatchQueue.global().async {
                do {
                    let actual = try bootstrap.shared()
                    XCTAssertTrue(actual === service)
                } catch { XCTFail("Unexpected shared error: \(error)") }
                consumers.fulfill()
            }
        }
        wait(for: [consumers], timeout: 2)
        XCTAssertEqual(creations, 1)
    }

    func testPreparationPropagatesOriginalFailureAndLaterInitializationCanSucceed() throws {
        let (service, _) = try uploader()
        let failed = expectation(description: "Preparation failure")
        var attempts = 0
        let bootstrap = WhoopBleUploadBootstrap(makeUploader: {
            attempts += 1
            if attempts == 1 { throw OpenError() }
            return service
        }, reportError: { XCTFail("Preparation failure belongs to caller: \($0)") })
        bootstrap.prepare { error in
            XCTAssertTrue(error is OpenError)
            failed.fulfill()
        }
        wait(for: [failed], timeout: 2)
        XCTAssertTrue(try bootstrap.shared() === service)
        XCTAssertEqual(attempts, 2)
    }

    func testFailedBackgroundAttachmentReportsAndCompletesOnceOnMain() {
        let reported = expectation(description: "Original failure reported")
        let completed = expectation(description: "OS completion")
        completed.assertForOverFulfill = true
        let bootstrap = WhoopBleUploadBootstrap(makeUploader: { throw OpenError() }, reportError: { error in
            XCTAssertTrue(error is OpenError)
            reported.fulfill()
        })
        bootstrap.handleBackgroundEvents {
            XCTAssertTrue(Thread.isMainThread)
            completed.fulfill()
        }
        wait(for: [reported, completed], timeout: 2)
    }

    func testSuccessfulAttachmentWaitsForFinishEventsAndCompletesOnlyOnce() throws {
        let (service, transport) = try uploader()
        let completed = expectation(description: "OS completion")
        completed.assertForOverFulfill = true
        let bootstrap = WhoopBleUploadBootstrap(makeUploader: { service }, reportError: {
            XCTFail("Unexpected bootstrap error: \($0)")
        })
        bootstrap.handleBackgroundEvents {
            XCTAssertTrue(Thread.isMainThread)
            completed.fulfill()
        }
        _ = try bootstrap.shared()
        _ = try service.diagnostics()
        transport.onFinishEvents?()
        transport.onFinishEvents?()
        _ = try service.diagnostics()
        wait(for: [completed], timeout: 2)
    }
}
