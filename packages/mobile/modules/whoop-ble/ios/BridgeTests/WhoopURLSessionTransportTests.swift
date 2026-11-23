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
            XCTAssertTrue(context.acceptsGzip)
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
        lock.withLock { source }?.succeed(Data("durable".utf8), headers: ["Accept-Encoding": "gzip"])
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

    func testAcknowledgmentRemainsOwnedUntilTheUploaderRetiresIt() async throws {
        let completed = expectation(description: "The network acknowledgment is waiting for the uploader")
        let enumerated = expectation(description: "The session has no replacement network task")
        let lock = NSLock()
        var background: URLSession?
        var requestsStarted = 0
        let (transport, request, file) = try makeTransport(makeBackgroundSession: { configuration, delegate, queue in
            let session = URLSession(configuration: configuration, delegate: delegate, delegateQueue: queue)
            lock.withLock { background = session }
            return session
        }, handler: { source in
            let first = lock.withLock {
                requestsStarted += 1
                return requestsStarted == 1
            }
            if first { source.succeed(Data("durable".utf8)) }
        })
        transport.onCompletion = { _, _, _, _, _ in completed.fulfill() }
        transport.start(request: request, file: file, identity: "generation.batch", attempt: 1)
        await fulfillment(of: [completed], timeout: 3)

        transport.start(request: request, file: file, identity: "generation.batch", attempt: 2)
        lock.withLock { background }?.getAllTasks { tasks in
            XCTAssertTrue(tasks.isEmpty)
            enumerated.fulfill()
        }
        await fulfillment(of: [enumerated], timeout: 3)
        transport.cancel(identity: "generation.batch")
    }

    func testMatchingCredentialsKeepARecoveredGzipTransfer() async throws {
        let started = expectation(description: "One restored gzip task remains active")
        let restored = expectation(description: "Task restored")
        let enumerated = expectation(description: "Original gzip task remains in its session")
        let completed = expectation(description: "The restored gzip task provides the acknowledgment")
        let lock = NSLock()
        var source: WhoopTransportURLProtocol?
        var background: URLSession?
        var retained = false
        let (transport, request, file) = try makeTransport(
            restored: true, requestHeaders: ["Content-Encoding": "gzip"],
            makeBackgroundSession: { configuration, delegate, queue in
                let session = URLSession(configuration: configuration, delegate: delegate, delegateQueue: queue)
                lock.withLock { background = session }
                return session
            }, handler: { upload in
                guard upload.request.value(forHTTPHeaderField: "Content-Encoding") == "gzip" else {
                    XCTFail("The session replaced the recovered gzip task")
                    return
                }
                lock.withLock { source = upload }
                started.fulfill()
            }
        )
        transport.allTasks { _ in restored.fulfill() }
        await fulfillment(of: [started, restored], timeout: 3)
        transport.onCompletion = { _, status, _, context, error in
            XCTAssertEqual(status, 200)
            XCTAssertTrue(context.sentGzip)
            XCTAssertEqual(context.attempt, 1)
            XCTAssertNil(error)
            completed.fulfill()
        }
        var plain = request
        plain.setValue(nil, forHTTPHeaderField: "Content-Encoding")
        transport.start(request: plain, file: file, identity: "generation.batch", attempt: 1)
        lock.withLock { background }?.getAllTasks { tasks in
            let original = tasks.contains {
                $0.state == .running && $0.originalRequest?.value(forHTTPHeaderField: "Content-Encoding") == "gzip"
            }
            lock.withLock { retained = original }
            XCTAssertTrue(original)
            enumerated.fulfill()
        }
        await fulfillment(of: [enumerated], timeout: 3)
        guard lock.withLock({ retained }) else { return }
        lock.withLock { source }?.succeed(Data("durable".utf8))
        await fulfillment(of: [completed], timeout: 3)
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
