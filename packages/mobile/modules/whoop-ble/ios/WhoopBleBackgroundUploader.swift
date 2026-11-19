import Foundation
import CoreFoundation

struct WhoopUploadTaskSnapshot {
    let identities: Set<String>
    /// Reservations with both a live request and an OS-managed fallback.
    let pairedIdentities: Set<String>
}

protocol WhoopUploadTransport: AnyObject {
    var onCompletion: WhoopUploadCompletion? { get set }
    var onAttemptFailure: ((String, Error, Int?) -> Void)? { get set }
    var onFinishEvents: (() -> Void)? { get set }
    func allTasks(_ completion: @escaping (WhoopUploadTaskSnapshot) -> Void)
    func start(request: URLRequest, file: URL, identity: String, attempt: Int)
    func cancel(identity: String)
}

struct WhoopUploadError: LocalizedError {
    let message: String
    var errorDescription: String? { message }
}

/// Native owner of the durable outbox. React and the Expo module are clients of this service.
final class WhoopBleBackgroundUploader: NSObject {
    private let store: WhoopBleSampleStore
    var sqliteCacheWritePages: Int? { store.cacheWritePages }
    private let directory: URL
    private let transport: WhoopUploadTransport
    private let reportError: (Error) -> Void
    private let reportUploadOutcome: (WhoopUploadOutcome) -> Void
    private let removeBodyFile: (URL) throws -> Void
    private let now: () -> Date
    private let queue = DispatchQueue(label: "app.dofek.whoop-ble.upload")
    private var token: String?
    private var headers: [String: String] = [:]
    private var active = Set<String>()
    private var pairedActive = Set<String>()
    private var blocked = Set<WhoopUploadStream>()
    private var retryAfter: [WhoopUploadStream: Date] = [:]
    private var lastSubmission: [WhoopUploadStream: Date] = [:]
    private var firstArrival: [WhoopUploadStream: Date] = [:]
    private var reconciling = false
    private var rerun = false
    private var wantsPartial = false
    private var wantsActiveRefresh = false
    private var completionHandler: (() -> Void)?
    private var finishedEventsPending = false
    private var lastError: String?
    private var lastUploadOutcome: WhoopUploadOutcome?
    private var http5xxResponseCount = 0
    private var tokenEpoch = 0
    private var submitted: [String: (epoch: Int, attempt: Int)] = [:]
    private var submissionSequence = 0
    private var authRetriedEpoch: [String: Int] = [:]
    private var lastCaptureSchedule: Date?
    private var reservationWriteSummary = WhoopReservationWriteSummary()
    private let createdAt = Date()

    init(store: WhoopBleSampleStore, directory: URL, transport: WhoopUploadTransport,
         reportError: @escaping (Error) -> Void,
         reportUploadOutcome: @escaping (WhoopUploadOutcome) -> Void = { _ in },
         removeBodyFile: @escaping (URL) throws -> Void = { try FileManager.default.removeItem(at: $0) },
         now: @escaping () -> Date = Date.init) throws {
        self.store = store; self.directory = directory; self.transport = transport; self.reportError = reportError
        self.reportUploadOutcome = reportUploadOutcome
        self.removeBodyFile = removeBodyFile
        self.now = now
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        var directory = directory
        var resources = URLResourceValues(); resources.isExcludedFromBackup = true
        try directory.setResourceValues(resources)
        #if os(iOS)
        try FileManager.default.setAttributes(
            [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication], ofItemAtPath: directory.path)
        #endif
        super.init()
        transport.onCompletion = { [weak self] identity, status, data, context, error in
            self?.queue.async { self?.completed(identity: identity, status: status, data: data, context: context, error: error) }
        }
        transport.onAttemptFailure = { [weak self] identity, error, attempt in
            self?.queue.async {
                guard let self, !self.isSuperseded(identity, attempt: attempt) else { return }
                do {
                    guard let batch = try self.store.pendingBatches().first(where: { self.identity($0) == identity }) else { return }
                    self.pairedActive.remove(identity)
                    self.retryAfter[batch.stream] = self.now().addingTimeInterval(30)
                    let transportData = (error as NSError).userInfo[WhoopUploadTelemetry.transportContextKey] as? [String: Any] ?? [:]
                    let outcome = WhoopUploadOutcome(
                        batchIdentity: identity, stream: batch.stream.rawValue, route: batch.stream.route,
                        stage: "path_failed_fallback_active", statusCode: nil,
                        responseOriginValidated: nil, acknowledgmentValidated: false, outboxState: "pending",
                        batchSampleCount: batch.sampleCount, attempt: attempt,
                        taskIdentifier: transportData["taskIdentifier"] as? Int,
                        transportPath: transportData["transportPath"] as? String,
                        siblingTaskPending: transportData["siblingTaskPending"] as? Bool,
                        occurredAt: Self.iso(self.now()))
                    self.lastUploadOutcome = outcome
                    self.reportUploadOutcome(outcome)
                    self.record(error, outcome: outcome)
                } catch { self.record(error) }
            }
        }
        transport.onFinishEvents = { [weak self] in
            self?.queue.async {
                guard let self else { return }
                self.finishedEventsPending = true
                self.finishBackgroundEventsIfReady()
            }
        }
        // Reattach the session before React is mounted. No token is needed to acknowledge old tasks.
        queue.async { self.schedule(partial: false) }
    }

    func configure(userId: String, serverURL: String, token: String, headers: [String: String]) throws {
        let origin = try WhoopUploadResponse.validatedOrigin(serverURL)
        guard !userId.isEmpty, !token.isEmpty, !token.contains("\r"), !token.contains("\n") else {
            throw WhoopUploadError(message: "WHOOP upload requires a user ID and session token")
        }
        let forbidden = Set(["authorization", "host", "cookie", "content-length", "content-type", "connection", "transfer-encoding"])
        guard headers.allSatisfy({
            !forbidden.contains($0.key.lowercased()) && !$0.key.contains("\r") && !$0.key.contains("\n") &&
                !$0.value.contains("\r") && !$0.value.contains("\n")
        }) else {
            throw WhoopUploadError(message: "WHOOP upload headers contain a reserved or invalid header")
        }
        try queue.sync {
            let binding = WhoopUploadBinding(userId: userId, serverURL: origin)
            let bindingChanged = try store.binding != binding
            if bindingChanged {
                lastUploadOutcome = nil
                self.token = nil; self.headers = [:]
                try cancelOwnedTasks()
                active.removeAll(); pairedActive.removeAll(); submitted.removeAll(); authRetriedEpoch.removeAll()
                try removeBodies()
            }
            try store.configure(binding)
            if bindingChanged { lastUploadOutcome = nil }
            tokenEpoch += 1
            self.token = token; self.headers = headers
            blocked.removeAll(); retryAfter.removeAll(); lastError = nil
            schedule(partial: true, refreshActive: true)
        }
    }

    func append(deviceId: String, samplesByStream: [WhoopUploadStream: [[String: Any]]]) throws {
        try queue.sync {
            try store.append(deviceId: deviceId, samplesByStream: samplesByStream)
            for (stream, samples) in samplesByStream where !samples.isEmpty && firstArrival[stream] == nil {
                firstArrival[stream] = now()
            }
            // Capture stays synchronous/durable; only scheduling work is coalesced.
            if lastCaptureSchedule.map({ now().timeIntervalSince($0) >= 5 }) ?? true {
                lastCaptureSchedule = now()
                schedule(partial: false)
            }
        }
    }

    func isManagedHistoryEnabled(for peripheralId: UUID) throws -> Bool {
        try queue.sync { try store.isManagedHistoryEnabled(for: peripheralId) }
    }

    func setManagedHistoryEnabled(_ enabled: Bool, for peripheralId: UUID) throws {
        try queue.sync { try store.setManagedHistoryEnabled(enabled, for: peripheralId) }
    }

    func flush() throws {
        try queue.sync {
            // Validate storage synchronously so callers receive storage failures.
            _ = try store.generation
            retryAfter.removeAll()
            schedule(partial: true, refreshActive: true)
        }
    }

    func disable(cutoff: Date? = nil, onStage: WhoopCleanupStageHandler = { _ in }) throws {
        onStage(WhoopCleanupStage("uploader_queue_wait"))
        try queue.sync { try disableLocked(cutoff: cutoff, onStage: onStage) }
    }

    private func disableLocked(cutoff: Date? = nil, onStage: WhoopCleanupStageHandler) throws {
        lastUploadOutcome = nil
        token = nil; headers = [:]; blocked.removeAll()
        onStage(WhoopCleanupStage("uploader_cancel_tasks"))
        try cancelOwnedTasks()
        if let cutoff {
            onStage(WhoopCleanupStage("uploader_advance_erasure_cutoff"))
            try store.advanceErasureCutoff(to: cutoff)
        }
        active.removeAll()
        pairedActive.removeAll()
        tokenEpoch += 1; submitted.removeAll()
        authRetriedEpoch.removeAll()
        retryAfter.removeAll()
        firstArrival.removeAll()
        lastSubmission.removeAll()
        lastCaptureSchedule = nil
        // Invalidate persisted completion identity even if file cleanup fails.
        onStage(WhoopCleanupStage("uploader_store_purge"))
        try store.purge(onStage: onStage)
        onStage(WhoopCleanupStage("uploader_remove_bodies"))
        try removeBodies()
    }

    func purge(cutoff: Date) throws {
        try queue.sync {
            try disableLocked(cutoff: cutoff, onStage: { _ in })
        }
    }

    func sampleCount(stream: WhoopUploadStream) throws -> Int {
        try queue.sync { try store.queuedCount(stream: stream, limit: Int.max) }
    }

    func diagnostics() throws -> [String: Any] {
        try queue.sync {
            var result: [String: Any] = [
                "bufferInstanceId": try store.generation,
                "bufferCreatedAt": Self.iso(createdAt), "checkpointAt": Self.iso(now()),
                "imu": try store.statistics(stream: .imu), "realtime": try store.statistics(stream: .realtime),
                "sensorRecords": try store.statistics(stream: .sensorRecords),
                "activeUploadCount": active.count, "blockedUploadStreams": blocked.map(\.rawValue),
                "http5xxResponseCount": http5xxResponseCount
            ]
            result["reservationWriteSummary"] = reservationWriteSummary.asDictionary
            result["lastUploadError"] = lastError.map { $0 as Any } ?? NSNull()
            result["lastUploadOutcome"] = lastUploadOutcome?.sentryData ?? NSNull()
            return result
        }
    }

    func handleBackgroundEvents(completionHandler: @escaping () -> Void) {
        queue.async {
            self.completionHandler = completionHandler
            self.finishBackgroundEventsIfReady()
        }
    }

    private func finishBackgroundEventsIfReady() {
        guard finishedEventsPending, let completion = completionHandler else { return }
        finishedEventsPending = false
        completionHandler = nil
        DispatchQueue.main.async(execute: completion)
    }

    private func cancelOwnedTasks() throws {
        // Capture identities before purging. URLSession enumeration may finish after a new owner starts work.
        for identity in active { transport.cancel(identity: identity) }
        for batch in try store.pendingBatches() where !active.contains(identity(batch)) {
            transport.cancel(identity: identity(batch))
        }
    }

    private func schedule(partial: Bool, refreshActive: Bool = false) {
        wantsPartial = wantsPartial || partial
        wantsActiveRefresh = wantsActiveRefresh || refreshActive
        if reconciling { rerun = true; return }
        reconciling = true
        transport.allTasks { [weak self] snapshot in
            guard let self else { return }
            self.queue.async {
                self.active = snapshot.identities
                self.pairedActive = snapshot.pairedIdentities
                let partial = self.wantsPartial
                let refreshActive = self.wantsActiveRefresh
                self.wantsPartial = false
                self.wantsActiveRefresh = false
                do {
                    let known = Set(try self.store.pendingBatches().map(self.identity))
                    for identity in snapshot.identities where !known.contains(identity) {
                        self.transport.cancel(identity: identity)
                        self.active.remove(identity)
                        self.pairedActive.remove(identity)
                    }
                    do {
                        for file in try FileManager.default.contentsOfDirectory(at: self.directory, includingPropertiesForKeys: nil)
                        where !known.contains(file.deletingPathExtension().lastPathComponent) {
                        do { try FileManager.default.removeItem(at: file) } catch { self.record(error) }
                        }
                    } catch { self.record(error) }
                    try self.submitAvailable(partial: partial, refreshActive: refreshActive)
                } catch { self.record(error) }
                self.reconciling = false
                if self.rerun { self.rerun = false; self.schedule(partial: false) }
            }
        }
    }

    private func submitAvailable(partial: Bool, refreshActive: Bool) throws {
        guard let token, let binding = try store.binding else { return }
        let pending = try store.pendingBatches()
        for stream in WhoopUploadStream.allCases {
            do {
                guard !blocked.contains(stream), retryAfter[stream].map({ $0 <= now() }) ?? true else { continue }
                if let batch = pending.first(where: { $0.stream == stream }),
                   pairedActive.contains(identity(batch)), !refreshActive { continue }
                let count = try store.queuedCount(stream: stream, limit: stream.batchLimit)
                let since = lastSubmission[stream] ?? firstArrival[stream] ?? now()
                guard count >= stream.batchLimit || partial || now().timeIntervalSince(since) >= 30 else { continue }
                guard let batch = try store.reserve(stream: stream, reportWrites: recordReservationWrites) else { continue }
                let identity = identity(batch)
                guard !pairedActive.contains(identity) || refreshActive else { continue }
                let file = directory.appendingPathComponent(identity + ".json")
                // Always regenerate atomically; the database is the only source of truth.
                try batch.body.write(to: file, options: .atomic)
                #if os(iOS)
                try FileManager.default.setAttributes(
                    [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication], ofItemAtPath: file.path)
                #endif
                let route = stream.route
                guard let url = URL(string: binding.serverURL + "/api/trpc/" + route) else {
                    throw WhoopUploadError(message: "Invalid WHOOP upload URL")
                }
                var request = URLRequest(url: url)
                request.httpMethod = "POST"
                for (name, value) in headers { request.setValue(value, forHTTPHeaderField: name) }
                request.setValue("application/json", forHTTPHeaderField: "Content-Type")
                request.setValue("Bearer " + token, forHTTPHeaderField: "Authorization")
                active.insert(identity); lastSubmission[stream] = now()
                pairedActive.insert(identity)
                submissionSequence += 1
                submitted[identity] = (tokenEpoch, submissionSequence)
                transport.start(request: request, file: file, identity: identity, attempt: submissionSequence)
            } catch {
                retryAfter[stream] = now().addingTimeInterval(30)
                record(error)
            }
        }
    }

    private func isSuperseded(_ identity: String, attempt: Int?) -> Bool {
        guard let latest = submitted[identity] else { return false }
        return latest.attempt != attempt
    }

    private func completed(identity: String, status: Int?, data: Data,
                           context: WhoopUploadCompletionContext, error: Error?) {
        guard !isSuperseded(identity, attempt: context.attempt) else { return }
        var nextPartial: Bool?
        var outcome: WhoopUploadOutcome?
        defer {
            submitted.removeValue(forKey: identity)
            transport.cancel(identity: identity)
            if let partial = nextPartial { schedule(partial: partial) }
        }
        active.remove(identity)
        pairedActive.remove(identity)
        let response = WhoopUploadResponse(
            status: status, data: data, responseURL: context.responseURL, error: error)
        var cleanupError: Error?
        do {
            guard let batch = try store.pendingBatches().first(where: { self.identity($0) == identity }) else {
                guard let generation = try? store.generation,
                      identity.hasPrefix(generation + ".") else { return }
                reportOutcome(WhoopUploadOutcome.batchNotFound(
                    identity: identity, status: status, context: context, occurredAt: Self.iso(now())))
                return
            }
            outcome = WhoopUploadOutcome.received(
                identity: identity, batch: batch, response: response, context: context,
                occurredAt: Self.iso(now()))
            guard try validateResponse(
                identity: identity, batch: batch, response: response,
                outcome: &outcome, nextPartial: &nextPartial) else { return }
            let retired = try store.acknowledge(id: batch.id, generation: batch.generation)
            outcome?.stage = retired ? "outbox_retired" : "outbox_already_absent"
            outcome?.outboxState = retired ? "retired" : "absent"
            authRetriedEpoch[identity] = nil
            let file = directory.appendingPathComponent(identity + ".json")
            if FileManager.default.fileExists(atPath: file.path) {
                do { try removeBodyFile(file) } catch {
                    outcome?.stage = "outbox_retired_cleanup_failed"
                    cleanupError = error
                }
            }
            retryAfter[batch.stream] = nil
            nextPartial = false
        } catch {
            let isKnownHTTP5xx = outcome?.isValidatedHttp5xxRejection == true
            if isKnownHTTP5xx { http5xxResponseCount += 1 }
            reportCompletionFailure(
                identity: identity, error: error, outcome: &outcome,
                reportToSentry: !isKnownHTTP5xx)
        }
        if let outcome, outcome.stage == "outbox_retired" || outcome.stage == "outbox_already_absent" {
            reportOutcome(outcome)
        }
        if let cleanupError {
            if let outcome { reportOutcome(outcome) }
            record(cleanupError, outcome: outcome)
        }
    }

    private func record(
        _ error: Error,
        outcome: WhoopUploadOutcome? = nil,
        reportToSentry: Bool = true
    ) {
        lastError = error.localizedDescription
        guard reportToSentry else { return }
        if let outcome {
            reportError(WhoopUploadTelemetry.adding(outcome.sentryData, to: error))
        } else {
            reportError(error)
        }
    }
    private func recordReservationWrites(_ measurement: WhoopSQLiteWriteMeasurement?) {
        reservationWriteSummary.record(measurement)
    }
    private func identity(_ batch: WhoopStoredBatch) -> String { batch.generation + "." + batch.id }
    private func removeBodies() throws {
        for file in try FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil) {
            try FileManager.default.removeItem(at: file)
        }
    }
    private static func iso(_ date: Date) -> String { ISO8601DateFormatter().string(from: date) }
}

private extension WhoopBleBackgroundUploader {
    func reportOutcome(_ outcome: WhoopUploadOutcome) {
        lastUploadOutcome = outcome
        reportUploadOutcome(outcome)
    }

    func validateResponse(
        identity: String,
        batch: WhoopStoredBatch,
        response: WhoopUploadResponse,
        outcome: inout WhoopUploadOutcome?,
        nextPartial: inout Bool?
    ) throws -> Bool {
        if let error = response.error { throw error }
        let validatedResponseOrigin: String?
        if let responseOrigin = response.originString {
            validatedResponseOrigin = try? WhoopUploadResponse.validatedOrigin(responseOrigin)
        } else {
            validatedResponseOrigin = nil
        }
        guard validatedResponseOrigin == batch.binding.serverURL else {
            outcome?.stage = "response_origin_rejected"
            outcome?.responseOriginValidated = false
            blocked.insert(batch.stream)
            throw WhoopUploadError(message: "WHOOP upload response changed origin")
        }
        outcome?.responseOriginValidated = true
        guard response.status == 200 else {
            outcome?.stage = "http_status_rejected"
            if let status = response.status, (400..<500).contains(status), status != 408, status != 429 {
                if status == 401 || status == 403, token != nil,
                   submitted[identity]?.epoch != tokenEpoch,
                   authRetriedEpoch[identity] != tokenEpoch {
                    authRetriedEpoch[identity] = tokenEpoch
                    if let outcome { reportOutcome(outcome) }
                    record(WhoopUploadError(message: "WHOOP upload used an expired session token"), outcome: outcome)
                    nextPartial = true
                    return false
                }
                blocked.insert(batch.stream)
            }
            throw WhoopUploadError(message: "WHOOP \(batch.stream.rawValue) upload returned HTTP \(response.status ?? 0)")
        }
        let json: Any?
        if response.data.count <= 65_536 {
            json = try? JSONSerialization.jsonObject(with: response.data)
        } else {
            json = nil
        }
        guard response.data.count <= 65_536,
              let json = json as? [String: Any],
              let result = json["result"] as? [String: Any],
              let value = result["data"] as? [String: Any],
              let inserted = value["inserted"] as? NSNumber,
              CFGetTypeID(inserted) != CFBooleanGetTypeID(),
              inserted.doubleValue.isFinite, inserted.doubleValue >= 0,
              inserted.doubleValue.rounded() == inserted.doubleValue else {
            outcome?.stage = "acknowledgment_invalid"
            blocked.insert(batch.stream)
            throw WhoopUploadError(message: "WHOOP upload returned an invalid acknowledgment")
        }
        outcome?.stage = "acknowledgment_validated"
        outcome?.acknowledgmentValidated = true
        return true
    }

    func reportCompletionFailure(
        identity: String,
        error: Error,
        outcome: inout WhoopUploadOutcome?,
        reportToSentry: Bool = true
    ) {
        var stateError: Error?
        do {
            let pendingBatch = try store.pendingBatches().first(where: { self.identity($0) == identity })
            outcome?.outboxState = pendingBatch == nil ? "absent" : "pending"
            if let batch = pendingBatch { retryAfter[batch.stream] = now().addingTimeInterval(30) }
        } catch {
            outcome?.outboxState = "unknown"
            stateError = error
        }
        if let outcome { reportOutcome(outcome) }
        if let stateError { record(stateError) }
        record(error, outcome: outcome, reportToSentry: reportToSentry)
    }
}
