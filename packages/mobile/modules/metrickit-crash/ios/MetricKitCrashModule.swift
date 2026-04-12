import ExpoModulesCore
import MetricKit
import Sentry

/// Expo native module that subscribes to MetricKit diagnostic payloads and
/// forwards MXCrashDiagnostic events to Sentry.
///
/// Sentry-cocoa has built-in MetricKit support for hangs, CPU exceptions,
/// and disk write exceptions, but intentionally skips crash diagnostics
/// (`disableCrashDiagnostics` defaults to `true`). This module fills that
/// gap for crashes that happen before Sentry's own crash handler initializes
/// (e.g., during CoreBluetooth state restoration at launch).
///
/// MetricKit delivers crash diagnostics from *previous* sessions on the
/// *current* launch, so by the time `didReceive` fires Sentry is already
/// initialized and ready to capture events.
public class MetricKitCrashModule: Module {

    private let subscriber = CrashDiagnosticSubscriber()

    public func definition() -> ModuleDefinition {
        Name("MetricKitCrash")

        OnCreate {
            MXMetricManager.shared.add(self.subscriber)
            NSLog("[MetricKitCrash] Registered MXMetricManager subscriber")
        }

        OnDestroy {
            MXMetricManager.shared.remove(self.subscriber)
        }
    }
}

/// MXMetricManagerSubscriber that extracts crash diagnostics and forwards
/// them to Sentry as fatal events with the raw call stack tree attached.
private class CrashDiagnosticSubscriber: NSObject, MXMetricManagerSubscriber {

    func didReceive(_ payloads: [MXDiagnosticPayload]) {
        for payload in payloads {
            guard let crashDiagnostics = payload.crashDiagnostics else { continue }

            for diagnostic in crashDiagnostics {
                forwardToSentry(diagnostic, payloadTimeStamp: payload.timeStampEnd)
            }
        }
    }

    private func forwardToSentry(
        _ diagnostic: MXCrashDiagnostic,
        payloadTimeStamp: Date
    ) {
        let event = Sentry.Event(level: .fatal)
        event.timestamp = payloadTimeStamp

        // Build a descriptive exception from the crash metadata
        let exceptionType = diagnostic.exceptionType?.intValue
        let exceptionCode = diagnostic.exceptionCode?.intValue
        let signal = diagnostic.signal?.intValue

        let parts = [
            exceptionType.map { "EXC_TYPE:\($0)" },
            exceptionCode.map { "EXC_CODE:\($0)" },
            signal.map { "SIGNAL:\($0)" },
        ].compactMap { $0 }

        let description = parts.isEmpty
            ? "MXCrashDiagnostic (no metadata)"
            : parts.joined(separator: " ")

        let exception = Sentry.Exception(value: description, type: "MXCrashDiagnostic")
        exception.mechanism = Mechanism(type: "MXCrashDiagnostic")
        exception.mechanism?.handled = false as NSNumber
        exception.mechanism?.synthetic = true as NSNumber

        if let reason = diagnostic.terminationReason {
            exception.mechanism?.description = reason
        }

        event.exceptions = [exception]
        event.tags = ["source": "metrickit"]

        // Attach the raw call stack tree JSON for server-side symbolication
        if let callStackTree = diagnostic.callStackTree {
            let callStackJson = callStackTree.jsonRepresentation()
            let attachment = Attachment(
                data: callStackJson,
                filename: "call-stack-tree.json",
                contentType: "application/json"
            )
            let scope = Scope()
            scope.addAttachment(attachment)
            SentrySDK.capture(event: event, scope: scope)
        } else {
            SentrySDK.capture(event: event)
        }

        NSLog("[MetricKitCrash] Forwarded crash diagnostic to Sentry: %@", description)
    }
}
