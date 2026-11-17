import HealthKit

func isCanceledHealthKitAuthorization(_ error: Error, didEnterBackground: Bool) -> Bool {
    guard let healthKitError = error as? HKError else {
        return false
    }
    // HealthKit also ends its permission sheet with code 5 when the app backgrounds.
    // Require a real background transition during this request; inactive system UI is insufficient.
    return healthKitError.code == .errorUserCanceled ||
        (didEnterBackground && healthKitError.code == .errorAuthorizationNotDetermined)
}
