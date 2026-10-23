import Foundation

extension BleHeartRateConnectionManager {
    func observeCollectionActivity() {
        collectionActivityObserver = NotificationCenter.default.addObserver(
            forName: Notification.Name("Dofek.collectionActivityRequested"),
            object: nil,
            queue: nil
        ) { [weak self] notification in
            guard let self, let collectors = notification.object as? NSMutableSet else { return }
            let hasReadyMonitor = {
                self.sessions.values.contains { $0.state == .ready }
            }
            let isCollecting = DispatchQueue.getSpecific(key: self.collectionActivityQueueKey) == true
                ? hasReadyMonitor()
                : self.bleQueue.sync(execute: hasReadyMonitor)
            if isCollecting {
                collectors.add("ble-heart-rate")
            }
        }
    }
}
