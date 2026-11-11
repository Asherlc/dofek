import ExpoModulesCore
import UIKit

public final class WhoopBleUploadAppDelegateSubscriber: ExpoAppDelegateSubscriber {
    public func application(_ application: UIApplication, handleEventsForBackgroundURLSession identifier: String,
                            completionHandler: @escaping () -> Void) {
        // Expo aggregates every subscriber's callback, including sessions owned by other modules.
        guard identifier == WhoopBleUploadRuntime.sessionIdentifier else {
            completionHandler()
            return
        }
        WhoopBleUploadRuntime.handleBackgroundEvents(completionHandler: completionHandler)
    }
}
