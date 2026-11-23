import Foundation

/// Gives the system one file-backed task for each durable reservation.
final class WhoopURLSessionTransport: NSObject, WhoopUploadTransport, URLSessionDataDelegate {
    var onCompletion: WhoopUploadCompletion?
    var onFinishEvents: (() -> Void)?

    private struct Submission {
        let request: URLRequest
        let file: URL
        let attempt: Int
    }

    private struct Delivery {
        let task: URLSessionTask
        let request: URLRequest?
        var attempt: Int?
        var cancelling = false
        var completed = false
        var replacement: Submission?
    }

    private let queue = DispatchQueue(label: "app.dofek.whoop-ble.transport")
    private let makeSession: (URLSessionConfiguration, URLSessionDelegate, OperationQueue) -> URLSession
    private var deliveries: [String: Delivery] = [:]
    private var retired = Set<Int>()
    private var responses: [Int: Data] = [:]
    private var oversized = Set<Int>()
    private lazy var session: URLSession = {
        let configuration = URLSessionConfiguration.background(withIdentifier: WhoopBleUploadRuntime.sessionIdentifier)
        configuration.sessionSendsLaunchEvents = true
        // iOS schedules background-started transfers at its discretion.
        // Foreground starts remain eligible for immediate delivery.
        configuration.isDiscretionary = false
        configuration.httpCookieStorage = nil
        configuration.httpShouldSetCookies = false
        configuration.urlCredentialStorage = nil
        configuration.urlCache = nil
        let delegates = OperationQueue()
        delegates.maxConcurrentOperationCount = 1
        delegates.underlyingQueue = queue
        return makeSession(configuration, self, delegates)
    }()

    init(makeSession: @escaping (URLSessionConfiguration, URLSessionDelegate, OperationQueue) -> URLSession = {
        URLSession(configuration: $0, delegate: $1, delegateQueue: $2)
    }) {
        self.makeSession = makeSession
        super.init()
    }

    func allTasks(_ completion: @escaping (Set<String>) -> Void) {
        queue.async {
            self.session.getAllTasks { tasks in
                self.queue.async {
                    for task in tasks where task.state != .completed && task.state != .canceling {
                        guard !self.retired.contains(task.taskIdentifier), let identity = task.taskDescription else { continue }
                        if let delivery = self.deliveries[identity] {
                            if delivery.task.taskIdentifier != task.taskIdentifier { self.retire(task) }
                        } else {
                            self.deliveries[identity] = Delivery(task: task, request: task.originalRequest)
                        }
                    }
                    let active = self.deliveries.compactMap { identity, delivery in
                        delivery.cancelling && delivery.replacement == nil ? nil : identity
                    }
                    completion(Set(active))
                }
            }
        }
    }

    @discardableResult
    func start(request: URLRequest, file: URL, identity: String, attempt: Int) -> Bool {
        // Complete submission before the uploader releases iOS's background callback.
        queue.sync {
            let submission = Submission(request: request, file: file, attempt: attempt)
            guard var delivery = self.deliveries[identity] else {
                self.submit(submission, identity: identity)
                return true
            }
            guard !delivery.completed else { return false }
            if !delivery.cancelling, self.matchesActiveRequest(delivery.request, request) {
                delivery.attempt = attempt
                self.deliveries[identity] = delivery
            } else {
                // Wait for the superseded task's terminal callback before creating its replacement.
                self.cancel(delivery, identity: identity, replacement: submission)
            }
            return true
        }
    }

    private func matchesActiveRequest(_ active: URLRequest?, _ requested: URLRequest) -> Bool {
        // The same reservation can be projected as JSON or gzip after relaunch.
        var active = active
        var requested = requested
        active?.setValue(nil, forHTTPHeaderField: "Content-Encoding")
        requested.setValue(nil, forHTTPHeaderField: "Content-Encoding")
        return active == requested
    }

    private func submit(_ submission: Submission, identity: String) {
        let task = session.uploadTask(with: submission.request, fromFile: submission.file)
        task.taskDescription = identity
        deliveries[identity] = Delivery(task: task, request: submission.request, attempt: submission.attempt)
        task.resume()
    }

    /// The owner calls this after durable acknowledgment or account retirement.
    func cancel(identity: String) {
        queue.async {
            if let delivery = self.deliveries[identity] {
                if delivery.completed {
                    self.deliveries[identity] = nil
                } else {
                    self.cancel(delivery, identity: identity)
                }
            } else {
                // A cold cancellation may precede the first restoration snapshot.
                self.session.getAllTasks { tasks in
                    self.cancelRestoredTasks(tasks, identity: identity)
                }
            }
        }
    }

    private func cancel(_ delivery: Delivery, identity: String, replacement: Submission? = nil) {
        var cancelled = delivery
        cancelled.cancelling = true
        cancelled.replacement = replacement
        deliveries[identity] = cancelled
        if !delivery.cancelling {
            responses[delivery.task.taskIdentifier] = nil
            oversized.remove(delivery.task.taskIdentifier)
            delivery.task.cancel()
        }
    }

    func cancelRestoredTasks(_ tasks: [URLSessionTask], identity: String) {
        queue.async {
            for task in tasks where task.taskDescription == identity {
                guard task.state != .completed, task.state != .canceling else { continue }
                if let current = self.deliveries[identity], current.task.taskIdentifier == task.taskIdentifier {
                    // A delayed enumeration cannot cancel a newer, locally submitted request.
                    guard !current.completed, current.attempt == nil else { continue }
                    self.cancel(current, identity: identity)
                } else {
                    self.retire(task)
                }
            }
        }
    }

    private func retire(_ task: URLSessionTask) {
        let key = task.taskIdentifier
        retired.insert(key)
        responses[key] = nil
        oversized.remove(key)
        task.cancel()
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        let key = dataTask.taskIdentifier
        guard !retired.contains(key), !oversized.contains(key),
              let identity = dataTask.taskDescription, deliveries[identity]?.cancelling != true else { return }
        guard (responses[key]?.count ?? 0) + data.count <= 65_536 else {
            responses[key] = nil
            oversized.insert(key)
            dataTask.cancel()
            return
        }
        responses[key, default: Data()].append(data)
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        let key = task.taskIdentifier
        let data = responses.removeValue(forKey: key) ?? Data()
        let wasOversized = oversized.remove(key) != nil
        guard retired.remove(key) == nil, let identity = task.taskDescription else { return }
        var delivery = deliveries[identity] ?? Delivery(task: task, request: task.originalRequest)
        guard delivery.task.taskIdentifier == key, !delivery.completed else { return }
        if delivery.cancelling {
            deliveries[identity] = nil
            if let replacement = delivery.replacement { submit(replacement, identity: identity) }
            return
        }
        // Keep the reservation fenced until its owner applies this result.
        delivery.completed = true
        deliveries[identity] = delivery
        // OS-delivered completions are valid before the task is restored or React configures uploads.
        let response = task.response as? HTTPURLResponse
        let acceptedEncodings = response?.value(forHTTPHeaderField: "Accept-Encoding")?
            .lowercased().split(separator: ",") ?? []
        let acceptsGzip = acceptedEncodings.contains { encoding in
            let parts = encoding.split(separator: ";", maxSplits: 1, omittingEmptySubsequences: false)
            guard parts.first?.trimmingCharacters(in: .whitespaces) == "gzip" else { return false }
            guard let parameter = parts.dropFirst().first else { return true }
            let quality = parameter.trimmingCharacters(in: .whitespaces)
            guard quality.hasPrefix("q="), let weight = Double(quality.dropFirst(2)) else { return false }
            return weight > 0 && weight <= 1
        }
        let context = WhoopUploadCompletionContext(
            attempt: delivery.attempt, responseURL: response?.url, taskIdentifier: key, transportPath: "background",
            acceptsGzip: acceptsGzip,
            sentGzip: task.originalRequest?.value(forHTTPHeaderField: "Content-Encoding") == "gzip"
        )
        onCompletion?(identity, response?.statusCode, data, context,
                      wasOversized ? WhoopUploadError(message: "WHOOP upload response exceeds 64 KiB") : error)
    }

    func urlSessionDidFinishEvents(forBackgroundURLSession session: URLSession) { onFinishEvents?() }
}
