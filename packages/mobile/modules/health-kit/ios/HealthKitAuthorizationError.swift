import HealthKit

func isUserCanceledHealthKitAuthorization(_ error: Error) -> Bool {
    guard let healthKitError = error as? HKError else {
        return false
    }
    return healthKitError.code == .errorUserCanceled
}
