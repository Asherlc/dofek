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
    static let taskCoordinatorDiagnostics = BackgroundRefreshDiagnostics.shared
    static let taskCoordinator = BackgroundRefreshTaskCoordinator(diagnostics: taskCoordinatorDiagnostics)
    static let taskIdKey = "taskId"

    /// NotificationCenter name used by the app delegate subscriber to
    /// relay background refresh events to this module instance.
    static let backgroundRefreshNotification = Notification.Name("BackgroundRefreshModule.onRefresh")

    private var notificationObserver: NSObjectProtocol?

    public func definition() -> ModuleDefinition {
        Name("BackgroundRefresh")

        Events("onBackgroundRefresh")

        AsyncFunction("enableCollectionNotifications") { (requestPermission: Bool, promise: Promise) in
            DispatchQueue.main.async {
                CollectionNotificationService.shared.enable(requestPermission: requestPermission) { result in
                    switch result {
                    case .success(let granted):
                        promise.resolve(granted)
                    case .failure(let error):
                        promise.reject("COLLECTION_NOTIFICATIONS_UNAVAILABLE", error.localizedDescription)
                    }
                }
            }
        }

        Function("disableCollectionNotifications") {
            DispatchQueue.main.async { CollectionNotificationService.shared.disable() }
        }

        OnStartObserving("onBackgroundRefresh") {
            self.startRefreshObserver()
            Self.taskCoordinator.setHandlerAvailable(true)
        }

        OnStopObserving("onBackgroundRefresh") {
            self.stopRefreshObserver()
        }

        Function("getDiagnostics") { Self.taskCoordinatorDiagnostics.payload }
        Function("clearDiagnostics") { Self.taskCoordinatorDiagnostics.clear() }
        Function("recordRefreshReceived") { (taskId: String) in
            Self.taskCoordinatorDiagnostics.record("js_received", fields: .init(taskId: taskId))
        }

        Function("scheduleRefresh") { BackgroundRefreshScheduler.schedule() }
        Function("isAvailable") { () -> Bool in
            UIApplication.shared.backgroundRefreshStatus == .available
        }
        Function("completeRefresh") { (taskId: String, success: Bool) in
            Self.taskCoordinator.completeTask(id: taskId, success: success)
        }
    }

    private func startRefreshObserver() {
        notificationObserver = NotificationCenter.default.addObserver(
            forName: Self.backgroundRefreshNotification,
            object: nil,
            queue: .main
        ) { [weak self] notification in
            guard let taskId = notification.userInfo?[Self.taskIdKey] as? String else {
                Self.taskCoordinatorDiagnostics.record("bridge_dispatched", fields: .init(success: false, reason: "missing_task_id"))
                BackgroundRefreshScheduler.captureFailure("missing_task_id")
                return
            }
            guard let self else {
                Self.taskCoordinatorDiagnostics.record("bridge_dispatched", fields: .init(
                    taskId: taskId, success: false, reason: "module_unavailable"
                ))
                BackgroundRefreshScheduler.captureFailure("module_unavailable")
                return
            }
            Self.taskCoordinatorDiagnostics.record("bridge_dispatched", fields: .init(taskId: taskId, success: true))
            self.sendEvent("onBackgroundRefresh", [Self.taskIdKey: taskId])
        }
    }

    private func stopRefreshObserver() {
        Self.taskCoordinator.setHandlerAvailable(false)
        if let observer = notificationObserver {
            NotificationCenter.default.removeObserver(observer)
            notificationObserver = nil
        }
    }

    /// Registration remains a launch-time app-delegate operation.
    static func registerBackgroundTask(handler: @escaping (BGAppRefreshTask) -> Void) {
        BackgroundRefreshScheduler.register(handler: handler)
    }
}
