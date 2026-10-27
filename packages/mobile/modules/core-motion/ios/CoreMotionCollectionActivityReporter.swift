import Foundation

final class CoreMotionCollectionActivityReporter {
    private let accountStateStore: CoreMotionAccountStateStore
    private let notificationCenter: NotificationCenter
    private let canRecord: () -> Bool
    private var observer: NSObjectProtocol?

    init(
        accountStateStore: CoreMotionAccountStateStore,
        notificationCenter: NotificationCenter = .default,
        canRecord: @escaping () -> Bool
    ) {
        self.accountStateStore = accountStateStore
        self.notificationCenter = notificationCenter
        self.canRecord = canRecord
        observer = notificationCenter.addObserver(
            forName: Notification.Name("Dofek.collectionActivityRequested"),
            object: nil,
            queue: nil
        ) { [weak self] notification in
            guard let self,
                  self.canRecord(),
                  self.accountStateStore.isRecordingActive,
                  let sources = notification.object as? NSMutableSet else { return }
            sources.add("core-motion")
        }
    }

    deinit {
        if let observer {
            notificationCenter.removeObserver(observer)
        }
    }
}
