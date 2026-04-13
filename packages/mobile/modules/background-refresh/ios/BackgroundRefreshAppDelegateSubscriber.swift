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
            let request = BGAppRefreshTaskRequest(identifier: BackgroundRefreshModule.taskIdentifier)
            request.earliestBeginDate = Date(timeIntervalSinceNow: 15 * 60)
            try? BGTaskScheduler.shared.submit(request)

            // Set expiration handler
            refreshTask.expirationHandler = {
                refreshTask.setTaskCompleted(success: false)
            }

            // Give the app ~10 seconds, then mark complete.
            // The JS event handler (onBackgroundRefresh) is only active when
            // the module is loaded, so background wakes without JS just
            // reschedule and complete.
            DispatchQueue.main.asyncAfter(deadline: .now() + 10) {
                refreshTask.setTaskCompleted(success: true)
            }
        }

        // Schedule the first refresh
        let request = BGAppRefreshTaskRequest(identifier: BackgroundRefreshModule.taskIdentifier)
        request.earliestBeginDate = Date(timeIntervalSinceNow: 15 * 60)
        try? BGTaskScheduler.shared.submit(request)

        return true
    }
}
