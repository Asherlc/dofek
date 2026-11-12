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
    static let healthKitSyncTaskCoordinator = HealthKitSyncTaskCoordinator(
        scheduler: HealthKitContinuedProcessingSchedulerFactory.make()
    )
    static let healthKitSyncTaskIdKey = "taskId"

    /// Issues a fresh ownership generation for each `onHealthKitSyncExpired`
    /// listener activation. A shared module can outlive one subscription, so the
    /// generation — not the module instance — owns queued native work.
    private let healthKitSyncListenerLifecycle = HealthKitSyncListenerLifecycle()

    /// NotificationCenter name used by the app delegate subscriber to
    /// relay background refresh events to this module instance.
    static let backgroundRefreshNotification = Notification.Name("BackgroundRefreshModule.onRefresh")

    private var notificationObserver: NSObjectProtocol?

    public func definition() -> ModuleDefinition {
        Name("BackgroundRefresh")

        Events("onBackgroundRefresh", "onHealthKitSyncExpired")

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
            BackgroundRefreshScheduler.refreshStatus() == .available
        }
        Function("completeRefresh") { (taskId: String, success: Bool) in
            Self.taskCoordinator.completeTask(id: taskId, success: success)
        }

        // The listener generation is snapshotted by the TypeScript wrapper before
        // Expo queues this async body. Re-reading it here would rebind an invocation
        // made by a retired listener to its replacement.
        AsyncFunction("startHealthKitSync") { (taskId: String, listenerGeneration: String, promise: Promise) in
            guard let ownerId = UUID(uuidString: listenerGeneration) else {
                promise.reject(
                    "HEALTHKIT_SYNC_TASK_FAILED",
                    HealthKitSyncStartError.listenerUnavailable.localizedDescription
                )
                return
            }
            // Continued-processing requests are submitted from the foreground.
            DispatchQueue.main.async {
                Self.healthKitSyncTaskCoordinator.start(taskId: taskId, ownerId: ownerId) { result in
                    switch result {
                    case .success(.launched):
                        promise.resolve(["supported": true])
                    case .success(.unsupported):
                        promise.resolve(["supported": false])
                    case .failure(let error):
                        promise.reject("HEALTHKIT_SYNC_TASK_FAILED", error.localizedDescription)
                    }
                }
            }
        }

        // Synchronous on the JS thread, so the caller can bind its invocation to the
        // listener that is live *now* rather than after Expo's async dispatch.
        Function("getHealthKitSyncListenerGeneration") { () -> String? in
            self.healthKitSyncListenerLifecycle.current()?.uuidString
        }

        Function("updateHealthKitSyncProgress") {
            (taskId: String, completed: Int, total: Int, message: String) in
            guard let ownerId = self.healthKitSyncListenerLifecycle.current() else { return }
            Self.healthKitSyncTaskCoordinator.updateProgress(
                taskId: taskId,
                ownerId: ownerId,
                completed: completed,
                total: total,
                message: message
            )
        }

        Function("completeHealthKitSync") { (taskId: String, success: Bool) in
            guard let ownerId = self.healthKitSyncListenerLifecycle.current() else { return }
            Self.healthKitSyncTaskCoordinator.complete(
                taskId: taskId,
                ownerId: ownerId,
                success: success
            )
        }

        OnStartObserving("onHealthKitSyncExpired") {
            let ownerId = self.healthKitSyncListenerLifecycle.begin()
            Self.healthKitSyncTaskCoordinator.activateOwner(ownerId: ownerId) { [weak self] taskId in
                self?.sendEvent("onHealthKitSyncExpired", [Self.healthKitSyncTaskIdKey: taskId])
            }
        }

        OnStopObserving("onHealthKitSyncExpired") {
            guard let ownerId = self.healthKitSyncListenerLifecycle.end() else { return }
            Self.healthKitSyncTaskCoordinator.deactivateOwner(ownerId: ownerId)
        }

        OnDestroy {
            // Retires only the generation this module still owns; a stale module's
            // destruction can never end a replacement listener's request.
            guard let ownerId = self.healthKitSyncListenerLifecycle.end() else { return }
            Self.healthKitSyncTaskCoordinator.destroyOwner(ownerId: ownerId)
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
