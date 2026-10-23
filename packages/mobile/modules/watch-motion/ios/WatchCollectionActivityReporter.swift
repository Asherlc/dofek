import Foundation

/// Reports background and live foreground capture from the Watch's latest native context.
final class WatchCollectionActivityReporter {
    private let notificationCenter: NotificationCenter
    private var observer: NSObjectProtocol?

    init(
        notificationCenter: NotificationCenter,
        recordingContext: @escaping () -> [String: Any],
        isWatchReachable: @escaping () -> Bool,
        isSyncEnabled: @escaping () -> Bool,
        deviceErasureCutoff: @escaping () -> Date?,
        now: @escaping () -> Date
    ) {
        self.notificationCenter = notificationCenter
        observer = notificationCenter.addObserver(
            forName: Notification.Name("Dofek.collectionActivityRequested"),
            object: nil,
            queue: nil
        ) { notification in
            guard isSyncEnabled() else { return }
            let context = recordingContext()
            let timestamp = now().timeIntervalSince1970
            let cutoff = deviceErasureCutoff()?.timeIntervalSince1970
            func validStart(_ key: String) -> Double? {
                guard let start = context[key] as? Double,
                      start.isFinite, start > 0, start <= timestamp,
                      cutoff.map({ start > $0 }) ?? true else { return nil }
                return start
            }

            let accelerometerIsActive = validStart("recordingStartedAt").map { start in
                guard let until = context["recordingUntil"] as? Double, until.isFinite else { return false }
                return until > timestamp && until > start
            } ?? false
            let foregroundIsActive = isWatchReachable() && ["gyroscopeStartedAt", "altimeterStartedAt"].contains {
                validStart($0) != nil
            }
            guard accelerometerIsActive || foregroundIsActive else { return }
            (notification.object as? NSMutableSet)?.add("watch-motion")
        }
    }

    deinit {
        if let observer { notificationCenter.removeObserver(observer) }
    }
}
