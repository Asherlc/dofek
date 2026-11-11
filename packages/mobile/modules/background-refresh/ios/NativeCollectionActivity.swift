import Foundation

/// Collectors answer synchronously from their own native state, without a JS round trip.
enum NativeCollectionActivity {
    static func isActive(notificationCenter: NotificationCenter = .default) -> Bool {
        let sources = NSMutableSet()
        notificationCenter.post(
            name: Notification.Name("Dofek.collectionActivityRequested"),
            object: sources
        )
        return !sources.allObjects.isEmpty
    }
}
