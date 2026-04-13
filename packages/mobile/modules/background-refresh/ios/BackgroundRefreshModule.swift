import BackgroundTasks
import ExpoModulesCore

/// Expo native module that registers a BGAppRefreshTask to periodically
/// wake the app in the background (~every 15-30 minutes, system-decided).
///
/// On each wake, the module emits an "onBackgroundRefresh" event so the
/// JS layer can restart Watch recording, reconnect WHOOP BLE, and sync
/// any buffered accelerometer data.
public class BackgroundRefreshModule: Module {

    static let taskIdentifier = "com.dofek.accelerometer-refresh"

    /// NotificationCenter name used by the app delegate subscriber to
    /// relay background refresh events to this module instance.
    static let backgroundRefreshNotification = Notification.Name("BackgroundRefreshModule.onRefresh")

    private var notificationObserver: NSObjectProtocol?

    public func definition() -> ModuleDefinition {
        Name("BackgroundRefresh")

        Events("onBackgroundRefresh")

        OnStartObserving {
            self.notificationObserver = NotificationCenter.default.addObserver(
                forName: Self.backgroundRefreshNotification,
                object: nil,
                queue: .main
            ) { [weak self] _ in
                self?.sendEvent("onBackgroundRefresh", [:])
            }
        }

        OnStopObserving {
            if let observer = self.notificationObserver {
                NotificationCenter.default.removeObserver(observer)
                self.notificationObserver = nil
            }
        }

        /// Schedule the next background refresh.
        /// Call this after each foreground sync to keep the schedule rolling.
        Function("scheduleRefresh") {
            self.scheduleAppRefresh()
        }

        /// Check if background refresh is available (user may have disabled it).
        Function("isAvailable") { () -> Bool in
            return UIApplication.shared.backgroundRefreshStatus == .available
        }
    }

    // MARK: - BGTaskScheduler

    /// Called by BackgroundRefreshAppDelegateSubscriber during
    /// application(_:didFinishLaunchingWithOptions:) — the only safe
    /// time to call BGTaskScheduler.register.
    static func registerBackgroundTask(handler: @escaping (BGAppRefreshTask) -> Void) {
        BGTaskScheduler.shared.register(
            forTaskWithIdentifier: taskIdentifier,
            using: nil
        ) { task in
            guard let refreshTask = task as? BGAppRefreshTask else {
                task.setTaskCompleted(success: false)
                return
            }
            handler(refreshTask)
        }
    }

    private func scheduleAppRefresh() {
        let request = BGAppRefreshTaskRequest(identifier: Self.taskIdentifier)
        // Let the system decide when to wake us — typically every 15-30 minutes
        // depending on usage patterns, battery state, and network conditions.
        request.earliestBeginDate = Date(timeIntervalSinceNow: 15 * 60) // 15 min minimum

        do {
            try BGTaskScheduler.shared.submit(request)
        } catch {
            // Submission can fail if called too early or too often — non-fatal
            print("[BackgroundRefresh] Failed to schedule: \(error.localizedDescription)")
        }
    }
}
