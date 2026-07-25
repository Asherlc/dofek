import BackgroundTasks
import ExpoModulesCore

/// Registers the BGAppRefreshTask during application launch.
///
/// BGTaskScheduler.register must be called during
/// application(_:didFinishLaunchingWithOptions:) on the main thread.
/// Expo's Module.OnCreate runs during React Native runtime initialization
/// which can happen on a background thread after launch completes,
/// causing an os_unfair_lock corruption crash.
public class BackgroundRefreshAppDelegateSubscriber: ExpoAppDelegateSubscriber {

    public func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        BackgroundRefreshModule.registerBackgroundTask { refreshTask in
            // Schedule the next refresh before doing work
            Self.scheduleRefresh()

            guard let taskId = BackgroundRefreshModule.taskCoordinator.beginTask(completion: { success in
                DispatchQueue.main.async {
                    refreshTask.setTaskCompleted(success: success)
                }
            }) else {
                return
            }

            refreshTask.expirationHandler = {
                BackgroundRefreshModule.taskCoordinator.expireTask(id: taskId)
            }

            // Emit event to JS via NotificationCenter so the module can
            // call sendEvent("onBackgroundRefresh"). The module subscribes
            // to this notification when it has active listeners.
            NotificationCenter.default.post(
                name: BackgroundRefreshModule.backgroundRefreshNotification,
                object: nil,
                userInfo: [BackgroundRefreshModule.taskIdKey: taskId]
            )
        }

        Self.scheduleRefresh()
        return true
    }

    private static func scheduleRefresh() {
        let request = BGAppRefreshTaskRequest(identifier: BackgroundRefreshModule.taskIdentifier)
        request.earliestBeginDate = Date(timeIntervalSinceNow: 15 * 60)
        do {
            try BGTaskScheduler.shared.submit(request)
        } catch {
            print("[BackgroundRefresh] Failed to schedule: \(error.localizedDescription)")
        }
    }
}
