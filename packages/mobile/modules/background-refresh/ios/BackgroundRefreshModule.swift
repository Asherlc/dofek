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

    public func definition() -> ModuleDefinition {
        Name("BackgroundRefresh")

        Events("onBackgroundRefresh")

        /// Register the BGAppRefreshTask with the system.
        /// Must be called once during app startup (before the end of
        /// `application(_:didFinishLaunchingWithOptions:)`).
        /// The Expo module system calls OnCreate early enough for this.
        OnCreate {
            self.registerBackgroundTask()
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

    private func registerBackgroundTask() {
        BGTaskScheduler.shared.register(
            forTaskWithIdentifier: Self.taskIdentifier,
            using: nil
        ) { [weak self] task in
            guard let refreshTask = task as? BGAppRefreshTask else {
                task.setTaskCompleted(success: false)
                return
            }
            self?.handleBackgroundRefresh(refreshTask)
        }

        // Schedule the first refresh
        scheduleAppRefresh()
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

    private func handleBackgroundRefresh(_ task: BGAppRefreshTask) {
        // Schedule the next refresh before doing work
        scheduleAppRefresh()

        // Set expiration handler (system gives us ~30 seconds)
        task.expirationHandler = {
            task.setTaskCompleted(success: false)
        }

        // Emit event to JS layer — the JS side will restart Watch recording,
        // reconnect WHOOP BLE, and sync accelerometer data.
        sendEvent("onBackgroundRefresh", [:])

        // Give JS ~10 seconds to do its work, then mark complete.
        // The JS side should call scheduleRefresh() when done for more accuracy,
        // but this timeout ensures we don't hold the task open forever.
        DispatchQueue.main.asyncAfter(deadline: .now() + 10) {
            task.setTaskCompleted(success: true)
        }
    }
}
