import XCTest
@testable import BackgroundRefreshLib

final class BackgroundRefreshTaskCoordinatorTests: XCTestCase {
    func testCompletesSuccessfulJavaScriptWork() throws {
        let coordinator = BackgroundRefreshTaskCoordinator(idGenerator: { "task-1" })
        var completions: [Bool] = []
        coordinator.setHandlerAvailable(true)

        let taskId = coordinator.beginTask { completions.append($0) }
        coordinator.completeTask(id: try XCTUnwrap(taskId), success: true)

        XCTAssertEqual(completions, [true])
    }

    func testCompletesFailedJavaScriptWork() throws {
        let coordinator = BackgroundRefreshTaskCoordinator(idGenerator: { "task-1" })
        var completions: [Bool] = []
        coordinator.setHandlerAvailable(true)

        let taskId = coordinator.beginTask { completions.append($0) }
        coordinator.completeTask(id: try XCTUnwrap(taskId), success: false)

        XCTAssertEqual(completions, [false])
    }

    func testFailsImmediatelyWhenNoJavaScriptHandlerIsAvailable() {
        let coordinator = BackgroundRefreshTaskCoordinator(idGenerator: { "task-1" })
        var completions: [Bool] = []

        let taskId = coordinator.beginTask { completions.append($0) }

        XCTAssertNil(taskId)
        XCTAssertEqual(completions, [false])
    }

    func testExpirationWinsAndLaterJavaScriptCompletionIsIgnored() throws {
        let coordinator = BackgroundRefreshTaskCoordinator(idGenerator: { "task-1" })
        var completions: [Bool] = []
        coordinator.setHandlerAvailable(true)
        let taskId = try XCTUnwrap(coordinator.beginTask { completions.append($0) })

        coordinator.expireTask(id: taskId)
        coordinator.completeTask(id: taskId, success: true)
        coordinator.completeTask(id: taskId, success: false)

        XCTAssertEqual(completions, [false])
    }

    func testRemovingHandlerFailsPendingTaskExactlyOnce() throws {
        let coordinator = BackgroundRefreshTaskCoordinator(idGenerator: { "task-1" })
        var completions: [Bool] = []
        coordinator.setHandlerAvailable(true)
        let taskId = try XCTUnwrap(coordinator.beginTask { completions.append($0) })

        coordinator.setHandlerAvailable(false)
        coordinator.expireTask(id: taskId)
        coordinator.completeTask(id: taskId, success: true)

        XCTAssertEqual(completions, [false])
    }
}

extension BackgroundRefreshTaskCoordinatorTests {
    func testDiagnosticsDistinguishMissingHandlerExpirationAndLateCompletion() throws {
        let defaults = UserDefaults(suiteName: "coordinator-tests-\(UUID().uuidString)")!
        let journal = BackgroundRefreshDiagnostics(userDefaults: defaults)
        let coordinator = BackgroundRefreshTaskCoordinator(idGenerator: { "task-1" }, diagnostics: journal)
        var completions: [Bool] = []
        XCTAssertNil(coordinator.beginTask { completions.append($0) })
        coordinator.setHandlerAvailable(true)
        let taskId = try XCTUnwrap(coordinator.beginTask { completions.append($0) })
        coordinator.expireTask(id: taskId)
        coordinator.completeTask(id: taskId, success: true)
        let events = try XCTUnwrap(journal.payload["events"] as? [[String: Any]])
        let completed = events.filter { $0["event"] as? String == "task_completed" }
        XCTAssertEqual(completed.compactMap { $0["reason"] as? String }, ["missing_listener", "expired"])
        XCTAssertEqual(completed.compactMap { $0["success"] as? Bool }, [false, false])
        XCTAssertEqual(events.last?["event"] as? String, "completion_requested")
        XCTAssertEqual(events.last?["reason"] as? String, "no_pending_task")
        XCTAssertEqual(events.filter { $0["event"] as? String == "task_expired" }.count, 1)
        XCTAssertEqual(events.filter { $0["event"] as? String == "task_launched" }.count, 2)
        XCTAssertEqual(completions, [false, false])
        journal.clear()
    }

    func testDiagnosticsRecordListenerRemovalAndJavaScriptResultsWithoutLockingCallbacks() throws {
        let defaults = UserDefaults(suiteName: "coordinator-tests-\(UUID().uuidString)")!
        let journal = BackgroundRefreshDiagnostics(userDefaults: defaults)
        let coordinator = BackgroundRefreshTaskCoordinator(diagnostics: journal)
        coordinator.setHandlerAvailable(true)
        for success in [true, false] {
            let taskId = try XCTUnwrap(coordinator.beginTask { _ in coordinator.setHandlerAvailable(true) })
            coordinator.completeTask(id: taskId, success: success)
        }
        _ = coordinator.beginTask { _ in coordinator.setHandlerAvailable(false) }
        coordinator.setHandlerAvailable(false)
        let events = try XCTUnwrap(journal.payload["events"] as? [[String: Any]])
        let completed = events.filter { $0["event"] as? String == "task_completed" }
        XCTAssertEqual(completed.compactMap { $0["reason"] as? String },
                       ["javascript_success", "javascript_failure", "listener_removed"])
        XCTAssertEqual(completed.compactMap { $0["success"] as? Bool }, [true, false, false])
        journal.clear()
    }
}
