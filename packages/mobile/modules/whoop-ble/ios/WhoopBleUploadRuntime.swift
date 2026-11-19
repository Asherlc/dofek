import Foundation
import RNSentry
import Sentry

/// Dofek application bootstrap; excluded from the standalone protocol package.
enum WhoopBleUploadRuntime {
    static let sessionIdentifier = "app.dofek.whoop-ble.upload.v1"
    private static let bootstrap = WhoopBleUploadBootstrap(makeUploader: makeUploader, reportError: reportNativeError)

    static func shared() throws -> WhoopBleBackgroundUploader {
        try bootstrap.shared()
    }

    static func prepare(onFailure: @escaping (Error) -> Void) {
        bootstrap.prepare(onFailure: onFailure)
    }

    static func handleBackgroundEvents(completionHandler: @escaping () -> Void) {
        bootstrap.handleBackgroundEvents(completionHandler: completionHandler)
    }

    private static func makeUploader() throws -> WhoopBleBackgroundUploader {
        let base = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
            .appendingPathComponent("WhoopBleUploads", isDirectory: true)
        let store = try WhoopBleSampleStore(directory: base)
        if let cutoff = UserDefaults.standard.object(forKey: "dofek_device_erasure_cutoff_v1") as? Date {
            try store.advanceErasureCutoff(to: cutoff)
        }
        return try WhoopBleBackgroundUploader(
            store: store,
            directory: base.appendingPathComponent("bodies", isDirectory: true),
            transport: WhoopURLSessionTransport(), reportError: reportNativeError,
            reportUploadOutcome: reportNativeUploadOutcome
        )
    }

    static func reportNativeError(_ error: Error) {
        let context = (error as NSError).userInfo[WhoopUploadTelemetry.contextKey] as? [String: Any]
        SentrySDK.capture(error: error) { scope in
            if let context { scope.setContext(value: context, key: "whoop_upload") }
        }
    }

    private static func reportNativeUploadOutcome(_ outcome: WhoopUploadOutcome) {
        if outcome.isValidatedHttp5xxRejection { return }
        let breadcrumb = Breadcrumb(level: .info, category: "whoop.upload")
        breadcrumb.message = outcome.stage
        breadcrumb.data = outcome.sentryData
        SentrySDK.addBreadcrumb(breadcrumb)
        reportConnectionLossMetrics(outcome)
    }

    private static func reportConnectionLossMetrics(_ outcome: WhoopUploadOutcome) {
        guard outcome.transportConnectionLost || outcome.connectionLossRecoveryDuration != nil else { return }
        let attributes: [String: SentryAttributeValue] = [
            "stream": outcome.stream,
            "cause": "network_connection_lost",
        ]
        if outcome.transportConnectionLost {
            var dropAttributes = attributes
            if let path = outcome.transportPath, path == "live" || path == "background" {
                dropAttributes["transport_path"] = path
            }
            SentrySDK.metrics.count("whoop.upload.connection_loss", value: 1,
                                    options: SentryMetricOptions(attributes: dropAttributes))
        }
        if let duration = outcome.connectionLossRecoveryDuration {
            let components = duration.components
            let seconds = Double(components.seconds) + Double(components.attoseconds) / 1e18
            SentrySDK.metrics.count("whoop.upload.connection_loss.recovered", value: 1,
                                    options: SentryMetricOptions(attributes: attributes))
            SentrySDK.metrics.distribution("whoop.upload.connection_loss.recovery_duration", value: seconds,
                                           options: SentryMetricOptions(unit: .second, attributes: attributes))
        }
    }
}
