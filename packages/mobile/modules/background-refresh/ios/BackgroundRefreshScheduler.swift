import BackgroundTasks
import RNSentry
import UIKit

/// The single scheduler boundary used by launch-time registration and JavaScript rescheduling.
enum BackgroundRefreshScheduler {
    static func refreshStatus() -> UIBackgroundRefreshStatus {
        if Thread.isMainThread {
            return UIApplication.shared.backgroundRefreshStatus
        }
        return DispatchQueue.main.sync { UIApplication.shared.backgroundRefreshStatus }
    }

    static func fields() -> BackgroundRefreshDiagnosticFields {
        let status: String
        switch refreshStatus() {
        case .available: status = "available"
        case .denied: status = "denied"
        case .restricted: status = "restricted"
        @unknown default: status = "unknown"
        }
        return .init(
            taskIdentifier: BackgroundRefreshModule.taskIdentifier,
            backgroundRefreshStatus: status,
            lowPowerModeEnabled: ProcessInfo.processInfo.isLowPowerModeEnabled
        )
    }

    static func register(handler: @escaping (BGAppRefreshTask) -> Void) {
        let registered = BGTaskScheduler.shared.register(
            forTaskWithIdentifier: BackgroundRefreshModule.taskIdentifier, using: nil
        ) { task in
            guard let refreshTask = task as? BGAppRefreshTask else {
                var context = fields()
                context.success = false
                context.reason = "unexpected_task_type"
                BackgroundRefreshDiagnostics.shared.record("task_completed", fields: context)
                captureFailure("unexpected_task_type")
                task.setTaskCompleted(success: false)
                return
            }
            handler(refreshTask)
        }
        var context = fields()
        context.success = registered
        BackgroundRefreshDiagnostics.shared.record("registration_result", fields: context)
        if !registered { captureFailure("registration_rejected") }
    }

    static func schedule() {
        let request = BGAppRefreshTaskRequest(identifier: BackgroundRefreshModule.taskIdentifier)
        request.earliestBeginDate = Date(timeIntervalSinceNow: 15 * 60)
        var context = fields()
        context.earliestBeginAt = request.earliestBeginDate
        BackgroundRefreshDiagnostics.shared.record("schedule_requested", fields: context)
        do {
            try BGTaskScheduler.shared.submit(request)
            context.success = true
            BackgroundRefreshDiagnostics.shared.record("schedule_succeeded", fields: context)
        } catch {
            context.success = false
            context.reason = "submit_failed"
            context.error = error
            BackgroundRefreshDiagnostics.shared.record("schedule_failed", fields: context)
            SentrySDK.capture(error: error) { scope in
                scope.setTag(value: "background-refresh-schedule", key: "source")
            }
        }
    }

    static func captureFailure(_ reason: String) {
        SentrySDK.capture(error: NSError(
            domain: "DofekBackgroundRefresh", code: 1,
            userInfo: [NSLocalizedDescriptionKey: reason]
        )) { scope in
            scope.setTag(value: "background-refresh-native", key: "source")
        }
    }
}
