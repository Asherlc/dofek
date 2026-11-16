import Foundation
import XCTest
@testable import ExpoWhoopBle

final class WhoopURLSessionTransportTests: XCTestCase {
    func testLiveNetworkFailurePreservesFallbackUntilItCompletes() async throws {
        let background = expectation(description: "Fallback remains available")
        let premature = expectation(description: "One failed path is not final delivery failure")
        premature.isInverted = true
        let completion = expectation(description: "Fallback can still acknowledge")
        let attemptFailure = expectation(description: "Failed live attempt is reported immediately")
        let lock = NSLock()
        var fallback: WhoopTransportURLProtocol?
        let (transport, request, file) = try makeTransport { source in
            if source.isBackground {
                lock.withLock { fallback = source }
                background.fulfill()
            } else { source.fail(URLError(.networkConnectionLost)) }
        }
        transport.onCompletion = { _, status, data, _, error in
            if error != nil { premature.fulfill() } else {
                XCTAssertEqual(status, 200)
                XCTAssertEqual(data, Data("durable".utf8))
                completion.fulfill()
            }
        }
        transport.onAttemptFailure = { identity, error, attempt in
            XCTAssertEqual(identity, "generation.batch")
            let nativeError = error as NSError
            XCTAssertEqual(nativeError.domain, NSURLErrorDomain)
            XCTAssertEqual(nativeError.code, URLError.networkConnectionLost.rawValue)
            let context = nativeError.userInfo[WhoopUploadTelemetry.transportContextKey] as? [String: Any]
            XCTAssertEqual(context?["transportPath"] as? String, "live")
            XCTAssertEqual(context?["siblingTaskPending"] as? Bool, true)
            XCTAssertNotNil(context?["taskIdentifier"] as? Int)
            XCTAssertEqual(attempt, 1)
            attemptFailure.fulfill()
        }
        transport.start(request: request, file: file, identity: "generation.batch", attempt: 1)
        await fulfillment(of: [background, attemptFailure, premature], timeout: 1)
        lock.withLock { fallback }?.succeed(Data("durable".utf8))
        await fulfillment(of: [completion], timeout: 3)
        transport.cancel(identity: "generation.batch")
    }

    func testLiveRequestCompletesWhileDurableFallbackIsPending() async throws {
        let background = expectation(description: "Durable fallback starts")
        let live = expectation(description: "Ordinary native request starts")
        let completion = expectation(description: "Live response reaches native owner")
        completion.assertForOverFulfill = true
        let (transport, request, file) = try makeTransport { source in
            if source.isBackground { background.fulfill() } else {
                live.fulfill()
                source.succeed(Data("live".utf8))
            }
        }
        transport.onCompletion = { identity, status, data, context, error in
            XCTAssertEqual(identity, "generation.batch")
            XCTAssertEqual(status, 200)
            XCTAssertNil(error)
            XCTAssertEqual(data, Data("live".utf8))
            XCTAssertEqual(context.attempt, 1)
            XCTAssertEqual(context.responseURL, request.url)
            XCTAssertEqual(context.transportPath, "live")
            XCTAssertNotNil(context.taskIdentifier)
            completion.fulfill()
        }
        transport.start(request: request, file: file, identity: "generation.batch", attempt: 1)
        await fulfillment(of: [background, live, completion], timeout: 3)
        let retained = expectation(description: "Fallback retained until owner handles acknowledgment")
        transport.allTasks { snapshot in
            XCTAssertEqual(snapshot.identities, ["generation.batch"])
            retained.fulfill()
        }
        await fulfillment(of: [retained], timeout: 3)
        let canceled = expectation(description: "Owner retires fallback after acknowledgment")
        WhoopTransportURLProtocol.stopped = { source in
            if source.request.url == request.url && source.isBackground { canceled.fulfill() }
        }
        transport.cancel(identity: "generation.batch")
        await fulfillment(of: [canceled], timeout: 3)
    }

    func testSessionTaskIdentifiersDoNotMixResponsesOrReportTwice() async throws {
        let completion = expectation(description: "Live completion")
        let duplicate = expectation(description: "No second logical completion")
        duplicate.isInverted = true
        let lock = NSLock()
        var sources: [Bool: WhoopTransportURLProtocol] = [:]
        var completions = 0
        let (transport, request, file) = try makeTransport { source in
            let pair = lock.withLock { () -> (WhoopTransportURLProtocol, WhoopTransportURLProtocol)? in
                sources[source.isBackground] = source
                guard let background = sources[true], let live = sources[false] else { return nil }
                return (background, live)
            }
            if let (background, live) = pair {
                background.succeed(Data("background-prefix".utf8), finish: false)
                live.succeed(Data("live-only".utf8))
            }
        }
        transport.onCompletion = { _, status, data, _, error in
            let count = lock.withLock { completions += 1; return completions }
            if count == 1 {
                XCTAssertEqual(status, 200)
                XCTAssertNil(error)
                XCTAssertEqual(data, Data("live-only".utf8))
                completion.fulfill()
            } else { duplicate.fulfill() }
        }
        transport.start(request: request, file: file, identity: "generation.batch", attempt: 1)
        await fulfillment(of: [completion], timeout: 3)
        lock.withLock { sources[true] }?.finish(Data("-tail".utf8))
        await fulfillment(of: [duplicate], timeout: 1)
        transport.cancel(identity: "generation.batch")
    }

    func testRestoredFallbackGetsOneLiveRequestWithoutRereserving() async throws {
        let background = expectation(description: "One restored fallback")
        background.assertForOverFulfill = true
        let live = expectation(description: "One live request")
        live.assertForOverFulfill = true
        let completion = expectation(description: "Restored batch completes on live path")
        let lock = NSLock()
        var liveSource: WhoopTransportURLProtocol?
        let (transport, request, file) = try makeTransport(restored: true) { source in
            if source.isBackground { background.fulfill() } else {
                lock.withLock { liveSource = source }
                live.fulfill()
            }
        }
        let restored = expectation(description: "Restored identity enumerated")
        transport.allTasks { snapshot in
            XCTAssertEqual(snapshot.identities, ["generation.batch"])
            restored.fulfill()
        }
        await fulfillment(of: [restored, background], timeout: 3)
        transport.onCompletion = { identity, status, _, context, error in
            XCTAssertEqual(identity, "generation.batch")
            XCTAssertEqual(status, 200)
            XCTAssertNil(error)
            XCTAssertEqual(context.attempt, 2)
            completion.fulfill()
        }
        transport.start(request: request, file: file, identity: "generation.batch", attempt: 1)
        transport.start(request: request, file: file, identity: "generation.batch", attempt: 2)
        await fulfillment(of: [live], timeout: 3)
        lock.withLock { liveSource }?.succeed(Data("restored".utf8))
        await fulfillment(of: [completion], timeout: 3)
        transport.cancel(identity: "generation.batch")
    }

    func testChangedCredentialsRetireRestoredRequestAndIgnoreItsCancellation() async throws {
        let oldStarted = expectation(description: "Restored old credential request")
        let oldCanceled = expectation(description: "Old credential request canceled")
        let completion = expectation(description: "Only current credential completion")
        completion.assertForOverFulfill = true
        let (transport, request, file) = try makeTransport(restored: true) { source in
            if source.request.value(forHTTPHeaderField: "X-Test-Credential") == "current" {
                if !source.isBackground { source.succeed(Data("current".utf8)) }
            } else { oldStarted.fulfill() }
        }
        WhoopTransportURLProtocol.stopped = { source in
            if source.request.url == request.url && source.request.value(forHTTPHeaderField: "X-Test-Credential") == nil {
                oldCanceled.fulfill()
            }
        }
        let restored = expectation(description: "Old request adopted")
        transport.allTasks { _ in restored.fulfill() }
        await fulfillment(of: [restored, oldStarted], timeout: 3)
        transport.onCompletion = { _, status, data, _, error in
            XCTAssertEqual(status, 200)
            XCTAssertEqual(data, Data("current".utf8))
            XCTAssertNil(error)
            completion.fulfill()
        }
        var current = request
        current.setValue("current", forHTTPHeaderField: "X-Test-Credential")
        transport.start(request: current, file: file, identity: "generation.batch", attempt: 1)
        await fulfillment(of: [oldCanceled, completion], timeout: 3)
        transport.cancel(identity: "generation.batch")
    }

    func testRestoredBackgroundCompletionDoesNotRequireLiveStartOrConfiguration() async throws {
        let completion = expectation(description: "Background-only completion delivered")
        let (transport, _, _) = try makeTransport(restored: true) { source in
            XCTAssertTrue(source.isBackground)
            source.succeed(Data("durable".utf8))
        }
        transport.onCompletion = { identity, status, data, _, error in
            XCTAssertEqual(identity, "generation.batch")
            XCTAssertEqual(status, 200)
            XCTAssertEqual(data, Data("durable".utf8))
            XCTAssertNil(error)
            completion.fulfill()
        }
        transport.allTasks { _ in }
        await fulfillment(of: [completion], timeout: 3)
        transport.cancel(identity: "generation.batch")
    }

    func testAccountCancellationRetiresBothPathsWithoutACompletion() async throws {
        let started = expectation(description: "Both paths active")
        started.expectedFulfillmentCount = 2
        let canceled = expectation(description: "Both retired paths canceled")
        canceled.expectedFulfillmentCount = 2
        let completion = expectation(description: "Retired paths cannot complete current work")
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

    func testOversizedLiveResponseRemainsAnExplicitFailure() async throws {
        let background = expectation(description: "Fallback retained")
        let completion = expectation(description: "Oversized response rejected")
        let (transport, request, file) = try makeTransport { source in
            if source.isBackground { background.fulfill() } else {
                source.succeed(Data(repeating: 1, count: 65_537))
            }
        }
        transport.onCompletion = { _, _, data, _, error in
            XCTAssertTrue(data.isEmpty)
            XCTAssertTrue(error?.localizedDescription.contains("64 KiB") == true)
            completion.fulfill()
        }
        transport.start(request: request, file: file, identity: "generation.batch", attempt: 1)
        await fulfillment(of: [background, completion], timeout: 3)
        transport.cancel(identity: "generation.batch")
    }
}

extension WhoopURLSessionTransportTests {
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
        transport.allTasks { snapshot in
            XCTAssertEqual(snapshot.identities, ["generation.batch"])
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

    func testDelayedCancellationDoesNotCancelReplacementTasks() async throws {
        let started = expectation(description: "Replacement paths active")
        started.expectedFulfillmentCount = 2
        let enumerated = expectation(description: "Late snapshot reaches cancellation phase")
        let premature = expectation(description: "Replacement fallback is not retired")
        premature.isInverted = true
        let completion = expectation(description: "Replacement live request completes")
        let lock = NSLock()
        var background: URLSession?
        var live: WhoopTransportURLProtocol?
        let (transport, request, file) = try makeTransport(makeBackgroundSession: { configuration, delegate, queue in
            let session = URLSession(configuration: configuration, delegate: delegate, delegateQueue: queue)
            lock.withLock { background = session }
            return session
        }, handler: { source in
            if !source.isBackground { lock.withLock { live = source } }
            started.fulfill()
        })
        transport.onCompletion = { _, status, _, _, error in
            XCTAssertEqual(status, 200)
            XCTAssertNil(error)
            completion.fulfill()
        }
        WhoopTransportURLProtocol.stopped = { source in
            if source.request.url == request.url { premature.fulfill() }
        }
        transport.start(request: request, file: file, identity: "generation.batch", attempt: 1)
        await fulfillment(of: [started], timeout: 3)
        lock.withLock { background }?.getAllTasks { tasks in
            transport.cancelRestoredTasks(tasks, identity: "generation.batch")
            enumerated.fulfill()
        }
        await fulfillment(of: [enumerated, premature], timeout: 1)
        WhoopTransportURLProtocol.stopped = nil
        lock.withLock { live }?.succeed(Data("replacement".utf8))
        await fulfillment(of: [completion], timeout: 3)
        transport.cancel(identity: "generation.batch")
    }
}
