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
        do {
            try WhoopBleUploadRuntime.shared().handleBackgroundEvents(completionHandler: completionHandler)
        } catch {
            WhoopBleUploadRuntime.reportNativeError(error)
            // Storage could not open; release the OS callback after surfacing the failure.
            DispatchQueue.main.async(execute: completionHandler)
        }
    }
}
