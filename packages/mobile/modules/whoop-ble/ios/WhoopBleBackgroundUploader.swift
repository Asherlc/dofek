import Foundation
import CoreFoundation

protocol WhoopUploadTransport: AnyObject {
    var onCompletion: ((String, Int?, Data, URL?, Error?) -> Void)? { get set }
    var onFinishEvents: (() -> Void)? { get set }
    func allTasks(_ completion: @escaping ([String]) -> Void)
    func start(request: URLRequest, file: URL, identity: String)
    func cancel(identity: String)
}

struct WhoopUploadError: LocalizedError {
    let message: String
    var errorDescription: String? { message }
}

/// Native owner of the durable outbox. React and the Expo module are clients of this service.
final class WhoopBleBackgroundUploader: NSObject {
    private let store: WhoopBleSampleStore
    private let directory: URL
    private let transport: WhoopUploadTransport
    private let reportError: (Error) -> Void
    private let now: () -> Date
    private let queue = DispatchQueue(label: "app.dofek.whoop-ble.upload")
    private var token: String?
    private var headers: [String: String] = [:]
    private var active = Set<String>()
    private var blocked = Set<WhoopUploadStream>()
    private var retryAfter: [WhoopUploadStream: Date] = [:]
    private var lastSubmission: [WhoopUploadStream: Date] = [:]
    private var firstArrival: [WhoopUploadStream: Date] = [:]
    private var reconciling = false
    private var rerun = false
    private var wantsPartial = false
    private var completionHandler: (() -> Void)?
    private var finishedEventsPending = false
    private var lastError: String?
    private var tokenEpoch = 0
    private var submittedEpoch: [String: Int] = [:]
    private var authRetriedEpoch: [String: Int] = [:]
    private var lastCaptureSchedule: Date?
    private let createdAt = Date()

    init(store: WhoopBleSampleStore, directory: URL, transport: WhoopUploadTransport,
         reportError: @escaping (Error) -> Void, now: @escaping () -> Date = Date.init) throws {
        self.store = store; self.directory = directory; self.transport = transport; self.reportError = reportError
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
        transport.onCompletion = { [weak self] identity, status, data, url, error in
            self?.queue.async { self?.completed(identity: identity, status: status, data: data, url: url, error: error) }
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
        let origin = try Self.validatedOrigin(serverURL)
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
            if try store.binding != binding {
                self.token = nil; self.headers = [:]
                try cancelOwnedTasks()
                active.removeAll(); submittedEpoch.removeAll(); authRetriedEpoch.removeAll()
                try removeBodies()
            }
            try store.configure(binding)
            tokenEpoch += 1
            self.token = token; self.headers = headers
            blocked.removeAll(); retryAfter.removeAll(); lastError = nil
            schedule(partial: true)
        }
    }

    func append(stream: WhoopUploadStream, deviceId: String, samples: [[String: Any]]) throws {
        try queue.sync {
            try store.append(stream: stream, deviceId: deviceId, samples: samples)
            if firstArrival[stream] == nil { firstArrival[stream] = now() }
            // Capture stays synchronous/durable; only scheduling work is coalesced.
            if lastCaptureSchedule.map({ now().timeIntervalSince($0) >= 5 }) ?? true {
                lastCaptureSchedule = now()
                schedule(partial: false)
            }
        }
    }

    func flush() throws {
        try queue.sync {
            // Validate storage synchronously so callers receive storage failures.
            _ = try store.generation
            retryAfter.removeAll()
            schedule(partial: true)
        }
    }

    func disable() throws {
        try queue.sync { try disableLocked() }
    }

    private func disableLocked() throws {
        token = nil; headers = [:]; blocked.removeAll()
        try cancelOwnedTasks()
        active.removeAll()
        tokenEpoch += 1; submittedEpoch.removeAll()
        authRetriedEpoch.removeAll()
        retryAfter.removeAll(); firstArrival.removeAll(); lastSubmission.removeAll()
        lastCaptureSchedule = nil
        // Invalidate persisted completion identity even if file cleanup fails.
        try store.purge()
        try removeBodies()
    }

    func purge(cutoff: Date) throws {
        try queue.sync {
            try disableLocked()
            try store.advanceErasureCutoff(to: cutoff)
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
                "activeUploadCount": active.count, "blockedUploadStreams": blocked.map(\.rawValue)
            ]
            result["lastUploadError"] = lastError.map { $0 as Any } ?? NSNull()
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

    private func schedule(partial: Bool) {
        wantsPartial = wantsPartial || partial
        if reconciling { rerun = true; return }
        reconciling = true
        transport.allTasks { [weak self] tasks in
            guard let self else { return }
            self.queue.async {
                self.active = Set(tasks)
                let partial = self.wantsPartial
                self.wantsPartial = false
                do {
                    let known = Set(try self.store.pendingBatches().map(self.identity))
                    for identity in tasks where !known.contains(identity) {
                        self.transport.cancel(identity: identity)
                        self.active.remove(identity)
                    }
                    for file in try FileManager.default.contentsOfDirectory(at: self.directory, includingPropertiesForKeys: nil)
                    where !known.contains(file.deletingPathExtension().lastPathComponent) {
                        try FileManager.default.removeItem(at: file)
                    }
                    try self.submitAvailable(partial: partial)
                } catch { self.record(error) }
                self.reconciling = false
                if self.rerun { self.rerun = false; self.schedule(partial: false) }
            }
        }
    }

    private func submitAvailable(partial: Bool) throws {
        guard let token, let binding = try store.binding else { return }
        let pending = try store.pendingBatches()
        for stream in WhoopUploadStream.allCases {
            guard !blocked.contains(stream), retryAfter[stream].map({ $0 <= now() }) ?? true else { continue }
            if let batch = pending.first(where: { $0.stream == stream }), active.contains(identity(batch)) { continue }
            let count = try store.queuedCount(stream: stream, limit: 500)
            let since = lastSubmission[stream] ?? firstArrival[stream] ?? now()
            guard count >= 500 || partial || now().timeIntervalSince(since) >= 30 else { continue }
            guard let batch = try store.reserve(stream: stream) else { continue }
            let identity = identity(batch)
            guard !active.contains(identity) else { continue }
            let file = directory.appendingPathComponent(identity + ".json")
            // Always regenerate atomically; the database is the only source of truth.
            try batch.body.write(to: file, options: .atomic)
            #if os(iOS)
            try FileManager.default.setAttributes(
                [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication], ofItemAtPath: file.path)
            #endif
            let route = stream == .imu ? "inertialMeasurementUnitSync.pushSamples" : "whoopBleSync.pushRealtimeData"
            guard let url = URL(string: binding.serverURL + "/api/trpc/" + route) else {
                throw WhoopUploadError(message: "Invalid WHOOP upload URL")
            }
            var request = URLRequest(url: url)
            request.httpMethod = "POST"
            for (name, value) in headers { request.setValue(value, forHTTPHeaderField: name) }
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.setValue("Bearer " + token, forHTTPHeaderField: "Authorization")
            active.insert(identity); lastSubmission[stream] = now()
            submittedEpoch[identity] = tokenEpoch
            transport.start(request: request, file: file, identity: identity)
        }
    }

    private func completed(identity: String, status: Int?, data: Data, url: URL?, error: Error?) {
        active.remove(identity)
        let usedEpoch = submittedEpoch.removeValue(forKey: identity)
        do {
            guard let batch = try store.pendingBatches().first(where: { self.identity($0) == identity }) else { return }
            if let error { throw error }
            guard let url, try Self.validatedOrigin(url.originString) == batch.binding.serverURL else {
                blocked.insert(batch.stream)
                throw WhoopUploadError(message: "WHOOP upload response changed origin")
            }
            guard status == 200 else {
                if let status, (400..<500).contains(status), status != 408, status != 429 {
                    if status == 401 || status == 403, token != nil, usedEpoch != tokenEpoch,
                       authRetriedEpoch[identity] != tokenEpoch {
                        authRetriedEpoch[identity] = tokenEpoch
                        record(WhoopUploadError(message: "WHOOP upload used an expired session token"))
                        schedule(partial: true)
                        return
                    }
                    blocked.insert(batch.stream)
                }
                throw WhoopUploadError(message: "WHOOP \(batch.stream.rawValue) upload returned HTTP \(status ?? 0)")
            }
            guard data.count <= 65_536,
                  let response = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let result = response["result"] as? [String: Any],
                  let value = result["data"] as? [String: Any],
                  let inserted = value["inserted"] as? NSNumber,
                  CFGetTypeID(inserted) != CFBooleanGetTypeID(),
                  inserted.doubleValue.isFinite, inserted.doubleValue >= 0,
                  inserted.doubleValue.rounded() == inserted.doubleValue else {
                blocked.insert(batch.stream)
                throw WhoopUploadError(message: "WHOOP upload returned an invalid acknowledgment")
            }
            _ = try store.acknowledge(id: batch.id, generation: batch.generation)
            authRetriedEpoch[identity] = nil
            let file = directory.appendingPathComponent(identity + ".json")
            if FileManager.default.fileExists(atPath: file.path) { try FileManager.default.removeItem(at: file) }
            retryAfter[batch.stream] = nil
            // Continue full batches only; partial tails wait for capture/lifecycle triggers.
            schedule(partial: false)
        } catch {
            do {
                if let batch = try store.pendingBatches().first(where: { self.identity($0) == identity }) {
                    retryAfter[batch.stream] = now().addingTimeInterval(30)
                }
            } catch { record(error) }
            record(error)
        }
    }

    private func record(_ error: Error) { lastError = error.localizedDescription; reportError(error) }
    private func identity(_ batch: WhoopStoredBatch) -> String { batch.generation + "." + batch.id }
    private func removeBodies() throws {
        for file in try FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil) {
            try FileManager.default.removeItem(at: file)
        }
    }
    private static func iso(_ date: Date) -> String { ISO8601DateFormatter().string(from: date) }
    private static func validatedOrigin(_ value: String) throws -> String {
        guard let parts = URLComponents(string: value), let host = parts.host, !host.isEmpty,
              parts.user == nil, parts.password == nil, parts.query == nil, parts.fragment == nil,
              parts.path.isEmpty || parts.path == "/" else { throw WhoopUploadError(message: "WHOOP server URL must be an HTTPS origin") }
        var allowed = parts.scheme?.lowercased() == "https"
        #if DEBUG
        allowed = allowed || (parts.scheme == "http" && ["localhost", "127.0.0.1", "::1"].contains(host))
        #endif
        guard allowed else { throw WhoopUploadError(message: "WHOOP server URL must use HTTPS") }
        var normalized = parts; normalized.path = ""; normalized.scheme = parts.scheme?.lowercased(); normalized.host = host.lowercased()
        guard let origin = normalized.string else { throw WhoopUploadError(message: "Invalid WHOOP server origin") }
        return origin
    }
}

private extension URL {
    var originString: String {
        guard var parts = URLComponents(url: self, resolvingAgainstBaseURL: false) else { return "" }
        parts.path = ""; parts.query = nil; parts.fragment = nil
        return parts.string ?? ""
    }
}
