import Foundation
import XCTest
@testable import ExpoWhoopBle

final class WhoopURLSessionTransportTests: XCTestCase {
    func testOneSystemTransferSurvivesRepeatedSubmission() async throws {
        let started = expectation(description: "One OS-managed transfer starts")
        started.assertForOverFulfill = true
        let completion = expectation(description: "Current attempt receives the acknowledgment")
        let enumerated = expectation(description: "The reservation remains active")
        let lock = NSLock()
        var source: WhoopTransportURLProtocol?
        let (transport, request, file) = try makeTransport { upload in
            XCTAssertTrue(upload.isBackground)
            lock.withLock { source = upload }
            started.fulfill()
        }
        transport.onCompletion = { identity, status, data, context, error in
            XCTAssertEqual(identity, "generation.batch")
            XCTAssertEqual(status, 200)
            XCTAssertNil(error)
            XCTAssertEqual(data, Data("durable".utf8))
            XCTAssertEqual(context.attempt, 2)
            XCTAssertEqual(context.responseURL, request.url)
            XCTAssertEqual(context.transportPath, "background")
            XCTAssertNotNil(context.taskIdentifier)
            completion.fulfill()
        }

        transport.start(request: request, file: file, identity: "generation.batch", attempt: 1)
        transport.start(request: request, file: file, identity: "generation.batch", attempt: 2)
        transport.allTasks { identities in
            XCTAssertEqual(identities, ["generation.batch"])
            enumerated.fulfill()
        }
        await fulfillment(of: [started, enumerated], timeout: 3)
        lock.withLock { source }?.succeed(Data("durable".utf8))
        await fulfillment(of: [completion], timeout: 3)
    }

    func testChangedCredentialsCancelRestoredTaskBeforeStartingReplacement() async throws {
        let oldStarted = expectation(description: "Restored old credential request")
        let oldCanceled = expectation(description: "Old credential request canceled")
        let completion = expectation(description: "Only current credential completion")
        completion.assertForOverFulfill = true
        let lock = NSLock()
        var oldStopped = false
        let (transport, request, file) = try makeTransport(restored: true) { source in
            if source.request.value(forHTTPHeaderField: "X-Test-Credential") == "current" {
                XCTAssertTrue(lock.withLock { oldStopped })
                source.succeed(Data("current".utf8))
            } else {
                oldStarted.fulfill()
            }
        }
        WhoopTransportURLProtocol.stopped = { source in
            if source.request.url == request.url && source.request.value(forHTTPHeaderField: "X-Test-Credential") == nil {
                lock.withLock { oldStopped = true }
                oldCanceled.fulfill()
            }
        }
        let restored = expectation(description: "Old request adopted")
        transport.allTasks { identities in
            XCTAssertEqual(identities, ["generation.batch"])
            restored.fulfill()
        }
        await fulfillment(of: [restored, oldStarted], timeout: 3)
        transport.onCompletion = { _, status, data, context, error in
            XCTAssertEqual(status, 200)
            XCTAssertEqual(data, Data("current".utf8))
            XCTAssertEqual(context.attempt, 1)
            XCTAssertNil(error)
            completion.fulfill()
        }
        var current = request
        current.setValue("current", forHTTPHeaderField: "X-Test-Credential")
        transport.start(request: current, file: file, identity: "generation.batch", attempt: 1)
        await fulfillment(of: [oldCanceled, completion], timeout: 3, enforceOrder: true)
    }

    func testRestoredBackgroundCompletionDoesNotRequireConfiguration() async throws {
        let completion = expectation(description: "Background completion delivered")
        let (transport, _, _) = try makeTransport(restored: true) { source in
            XCTAssertTrue(source.isBackground)
            source.succeed(Data("durable".utf8))
        }
        transport.onCompletion = { identity, status, data, context, error in
            XCTAssertEqual(identity, "generation.batch")
            XCTAssertEqual(status, 200)
            XCTAssertEqual(data, Data("durable".utf8))
            XCTAssertNil(context.attempt)
            XCTAssertNil(error)
            completion.fulfill()
        }
        transport.allTasks { _ in }
        await fulfillment(of: [completion], timeout: 3)
    }

    func testAccountCancellationRetiresTheTaskWithoutDeliveringCompletion() async throws {
        let started = expectation(description: "File-backed request active")
        let canceled = expectation(description: "Account task canceled")
        let completion = expectation(description: "Retired task cannot complete current work")
        completion.isInverted = true
        let (transport, request, file) = try makeTransport { _ in started.fulfill() }
        WhoopTransportURLProtocol.stopped = { source in
            if source.request.url == request.url { canceled.fulfill() }
        }
        transport.onCompletion = { _, _, _, _, _ in completion.fulfill() }
        transport.start(request: request, file: file, identity: "generation.batch", attempt: 1)
        await fulfillment(of: [started], timeout: 3)
        transport.cancel(identity: "generation.batch")
        await fulfillment(of: [canceled, completion], timeout: 1)
    }

    func testOversizedResponseRemainsAnExplicitFailure() async throws {
        let completion = expectation(description: "Oversized response rejected")
        let (transport, request, file) = try makeTransport { source in
            source.succeed(Data(repeating: 1, count: 65_537))
        }
        transport.onCompletion = { _, _, data, _, error in
            XCTAssertTrue(data.isEmpty)
            XCTAssertTrue(error?.localizedDescription.contains("64 KiB") == true)
            completion.fulfill()
        }
        transport.start(request: request, file: file, identity: "generation.batch", attempt: 1)
        await fulfillment(of: [completion], timeout: 3)
    }

    func testDelayedCancellationStillCancelsAnAdoptedRestoredTask() async throws {
        let started = expectation(description: "Restored background request active")
        let adopted = expectation(description: "Restoration adopts task before cancellation snapshot returns")
        let canceled = expectation(description: "Retired request canceled despite adoption")
        let enumerated = expectation(description: "Delayed cancellation receives real session tasks")
        let lock = NSLock()
        var background: URLSession?
        let (transport, request, _) = try makeTransport(restored: true, makeBackgroundSession: { configuration, delegate, queue in
            let session = URLSession(configuration: configuration, delegate: delegate, delegateQueue: queue)
            lock.withLock { background = session }
            return session
        }, handler: { _ in started.fulfill() })
        WhoopTransportURLProtocol.stopped = { source in
            if source.request.url == request.url { canceled.fulfill() }
        }
        transport.onCompletion = { _, _, _, _, _ in XCTFail("Intentional cancellation is not a delivery completion") }
        transport.allTasks { identities in
            XCTAssertEqual(identities, ["generation.batch"])
            adopted.fulfill()
        }
        await fulfillment(of: [started, adopted], timeout: 3)
        lock.withLock { background }?.getAllTasks { tasks in
            XCTAssertEqual(tasks.count, 1)
            transport.cancelRestoredTasks(tasks, identity: "generation.batch")
            enumerated.fulfill()
        }
        await fulfillment(of: [enumerated, canceled], timeout: 3)
    }

    func testDelayedCancellationDoesNotCancelReplacementTask() async throws {
        let started = expectation(description: "Replacement active")
        let enumerated = expectation(description: "Late snapshot reaches cancellation phase")
        let completion = expectation(description: "Replacement completes")
        let lock = NSLock()
        var background: URLSession?
        var upload: WhoopTransportURLProtocol?
        let (transport, request, file) = try makeTransport(makeBackgroundSession: { configuration, delegate, queue in
            let session = URLSession(configuration: configuration, delegate: delegate, delegateQueue: queue)
            lock.withLock { background = session }
            return session
        }, handler: { source in
            lock.withLock { upload = source }
            started.fulfill()
        })
        transport.onCompletion = { _, status, _, _, error in
            XCTAssertEqual(status, 200)
            XCTAssertNil(error)
            completion.fulfill()
        }
        transport.start(request: request, file: file, identity: "generation.batch", attempt: 1)
        await fulfillment(of: [started], timeout: 3)
        lock.withLock { background }?.getAllTasks { tasks in
            transport.cancelRestoredTasks(tasks, identity: "generation.batch")
            // A second snapshot runs after the delayed cancellation on the transport queue.
            transport.allTasks { identities in
                XCTAssertEqual(identities, ["generation.batch"])
                enumerated.fulfill()
            }
        }
        await fulfillment(of: [enumerated], timeout: 3)
        lock.withLock { upload }?.succeed(Data("replacement".utf8))
        await fulfillment(of: [completion], timeout: 3)
    }
}
