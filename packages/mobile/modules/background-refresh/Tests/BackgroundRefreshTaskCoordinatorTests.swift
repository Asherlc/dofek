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
