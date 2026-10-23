import Foundation

/// Reports the Watch's confirmed recording window from its latest native application context.
final class WatchCollectionActivityReporter {
    private let notificationCenter: NotificationCenter
    private var observer: NSObjectProtocol?

    init(
        notificationCenter: NotificationCenter,
        recordingContext: @escaping () -> [String: Any],
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
            guard let startedAt = context["recordingStartedAt"] as? Double,
                  let until = context["recordingUntil"] as? Double,
                  startedAt.isFinite, until.isFinite,
                  startedAt < until,
                  startedAt <= now().timeIntervalSince1970,
                  until > now().timeIntervalSince1970 else { return }
            if let cutoff = deviceErasureCutoff(), startedAt <= cutoff.timeIntervalSince1970 {
                return
            }
            (notification.object as? NSMutableSet)?.add("watch-motion")
        }
    }

    deinit {
        if let observer { notificationCenter.removeObserver(observer) }
    }
}
