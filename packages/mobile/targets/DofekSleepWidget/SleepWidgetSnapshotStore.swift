import Foundation

/// Reads the purgeable App Group Sleep snapshot for WidgetKit.
enum SleepWidgetSnapshotStore {
    /// Widget extension bundle is `<host>.sleep-widget`; group is `group.<that>`.
    static func appGroupIdentifierForWidgetBundle(_ widgetBundleIdentifier: String) -> String {
        "group.\(widgetBundleIdentifier)"
    }

    static func snapshotURL(containerURL: URL) -> URL {
        containerURL.appendingPathComponent(SleepWidgetSnapshot.relativeCachePath, isDirectory: false)
    }

    static func load(
        fileManager: FileManager = .default,
        widgetBundleIdentifier: String? = Bundle.main.bundleIdentifier,
        nowMilliseconds: Int64 = Int64(Date().timeIntervalSince1970 * 1000)
    ) -> SleepWidgetSnapshot {
        guard let widgetBundleIdentifier else { return .needsUpdate }
        let groupId = appGroupIdentifierForWidgetBundle(widgetBundleIdentifier)
        guard let container = fileManager.containerURL(forSecurityApplicationGroupIdentifier: groupId) else {
            return .needsUpdate
        }
        let url = snapshotURL(containerURL: container)
        guard let data = try? Data(contentsOf: url) else { return .needsUpdate }
        return SleepWidgetSnapshot.resolve(data: data, nowMilliseconds: nowMilliseconds)
    }
}
