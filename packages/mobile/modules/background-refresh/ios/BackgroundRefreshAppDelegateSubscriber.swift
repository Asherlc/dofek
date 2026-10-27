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
        CollectionNotificationService.shared.start()
        BackgroundRefreshModule.registerBackgroundTask { refreshTask in
            // Schedule the next refresh before doing work
            BackgroundRefreshScheduler.schedule()

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

        BackgroundRefreshScheduler.schedule()
        return true
    }

    public func applicationDidBecomeActive(_ application: UIApplication) {
        CollectionNotificationService.shared.appBecameActive()
    }

    public func applicationWillTerminate(_ application: UIApplication) {
        CollectionNotificationService.shared.appWillTerminate()
    }
}
