import ExpoModulesCore
import Foundation
import WidgetKit

public class SleepWidgetModule: Module {
    public func definition() -> ModuleDefinition {
        Name("SleepWidget")

        Function("replaceSnapshot") { (snapshot: String?) in
            guard let hostBundleIdentifier = Bundle.main.bundleIdentifier,
                  !hostBundleIdentifier.isEmpty
            else {
                throw Exception(
                    name: "SleepWidgetSnapshotError",
                    description: "Unable to update the Sleep widget snapshot."
                )
            }
            let groupId = SleepWidgetSnapshotWriter.appGroupIdentifier(
                hostBundleIdentifier: hostBundleIdentifier
            )
            guard let containerURL = FileManager.default.containerURL(
                forSecurityApplicationGroupIdentifier: groupId
            ) else {
                throw Exception(
                    name: "SleepWidgetSnapshotError",
                    description: "Unable to update the Sleep widget snapshot."
                )
            }

            do {
                let changed = try SleepWidgetSnapshotWriter.replaceSnapshot(
                    snapshot,
                    containerURL: containerURL
                )
                if changed {
                    WidgetCenter.shared.reloadTimelines(ofKind: SleepWidgetSnapshotWriter.widgetKind)
                }
            } catch {
                throw Exception(
                    name: "SleepWidgetSnapshotError",
                    description: "Unable to update the Sleep widget snapshot."
                )
            }
        }
    }
}
