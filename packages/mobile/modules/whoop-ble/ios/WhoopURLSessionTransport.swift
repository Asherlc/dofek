import Foundation

/// One durable reservation may use two network paths, but reports one completion.
final class WhoopURLSessionTransport: NSObject, WhoopUploadTransport, URLSessionDataDelegate {
    var onCompletion: ((String, Int?, Data, (attempt: Int?, responseURL: URL?), Error?) -> Void)?
    var onAttemptFailure: ((String, Error, Int?) -> Void)?
    var onFinishEvents: (() -> Void)?
    private final class Delivery {
        var request: URLRequest?
        var tasks: [String: URLSessionTask] = [:]
        var reported = false
        var startedHere = false
        var attempt: Int?
        init(request: URLRequest?) { self.request = request }
    }
    private let queue = DispatchQueue(label: "app.dofek.whoop-ble.transport")
    private let makeSession: (URLSessionConfiguration, URLSessionDelegate, OperationQueue) -> URLSession
    private var deliveries: [String: Delivery] = [:]
    private var retired = Set<String>()
    private var responses: [String: Data] = [:]
    private var oversized = Set<String>()
    private lazy var delegates: OperationQueue = {
        let value = OperationQueue()
        value.maxConcurrentOperationCount = 1
        value.underlyingQueue = queue
        return value
    }()
    private lazy var backgroundSession: URLSession = {
        #if os(iOS)
        let configuration = URLSessionConfiguration.background(withIdentifier: WhoopBleUploadRuntime.sessionIdentifier)
        configuration.sessionSendsLaunchEvents = true
        configuration.isDiscretionary = false
        #else
        let configuration = URLSessionConfiguration.default
        #endif
        return configuredSession(configuration)
    }()
    private lazy var liveSession: URLSession = {
        let configuration = URLSessionConfiguration.default
        configuration.waitsForConnectivity = true
        return configuredSession(configuration)
    }()

    init(makeSession: @escaping (URLSessionConfiguration, URLSessionDelegate, OperationQueue) -> URLSession = {
        URLSession(configuration: $0, delegate: $1, delegateQueue: $2)
    }) {
        self.makeSession = makeSession
        super.init()
    }

    private func configuredSession(_ configuration: URLSessionConfiguration) -> URLSession {
        configuration.httpCookieStorage = nil
        configuration.httpShouldSetCookies = false
        configuration.urlCredentialStorage = nil
        configuration.urlCache = nil
        return makeSession(configuration, self, delegates)
    }

    private func key(_ session: URLSession, _ task: URLSessionTask) -> String {
        (session === backgroundSession ? "background." : "live.") + String(task.taskIdentifier)
    }

    func allTasks(_ completion: @escaping (WhoopUploadTaskSnapshot) -> Void) {
        queue.async {
            let backgroundSession = self.backgroundSession
            let liveSession = self.liveSession
            backgroundSession.getAllTasks { background in
                liveSession.getAllTasks { live in
                    self.queue.async {
                        var identities = Set<String>()
                        var backgroundIdentities = Set<String>()
                        var liveIdentities = Set<String>()
                        for (session, tasks) in [(self.backgroundSession, background), (self.liveSession, live)] {
                            for task in tasks where task.state != .completed && task.state != .canceling {
                                let key = self.key(session, task)
                                guard !self.retired.contains(key), let identity = task.taskDescription else { continue }
                                let delivery = self.deliveries[identity] ?? Delivery(request: task.originalRequest)
                                if delivery.startedHere, delivery.tasks[key] == nil {
                                    self.retire(task, key: key)
                                    continue
                                }
                                delivery.tasks[key] = task
                                self.deliveries[identity] = delivery
                                identities.insert(identity)
                                if session === self.backgroundSession {
                                    backgroundIdentities.insert(identity)
                                } else {
                                    liveIdentities.insert(identity)
                                }
                            }
                        }
                        completion(WhoopUploadTaskSnapshot(
                            identities: identities, pairedIdentities: backgroundIdentities.intersection(liveIdentities)))
                    }
                }
            }
        }
    }

    func start(request: URLRequest, file: URL, identity: String, attempt: Int) {
        queue.async {
            if let prior = self.deliveries[identity], prior.request != request || prior.reported {
                self.retire(prior)
                self.deliveries[identity] = nil
            }
            let delivery = self.deliveries[identity] ?? Delivery(request: request)
            delivery.startedHere = true
            delivery.attempt = attempt
            self.deliveries[identity] = delivery
            for session in [self.backgroundSession, self.liveSession] {
                let prefix = session === self.backgroundSession ? "background." : "live."
                guard !delivery.tasks.contains(where: {
                    $0.key.hasPrefix(prefix) && $0.value.state != .completed && $0.value.state != .canceling
                }) else { continue }
                let task = session.uploadTask(with: request, fromFile: file)
                task.taskDescription = identity
                delivery.tasks[self.key(session, task)] = task
                task.resume()
            }
        }
    }

    /// The owner calls this after durable acknowledgment or explicit failure handling.
    func cancel(identity: String) {
        queue.async {
            if let delivery = self.deliveries.removeValue(forKey: identity) {
                self.retire(delivery)
            } else {
                // Cancellation can precede the first restoration snapshot. Do not
                // let its late enumeration cancel tasks of a replacement attempt.
                self.backgroundSession.getAllTasks { tasks in
                    self.cancelRestoredTasks(tasks, identity: identity)
                }
            }
        }
    }

    func cancelRestoredTasks(_ tasks: [URLSessionTask], identity: String) {
        queue.async {
            for task in tasks where task.taskDescription == identity {
                let key = self.key(self.backgroundSession, task)
                guard task.state != .completed, task.state != .canceling else { continue }
                if let current = self.deliveries[identity], current.startedHere, current.tasks[key] != nil { continue }
                self.retire(task, key: key)
                self.deliveries[identity]?.tasks[key] = nil
                if self.deliveries[identity]?.tasks.isEmpty == true { self.deliveries[identity] = nil }
            }
        }
    }

    private func retire(_ delivery: Delivery) {
        for (key, task) in delivery.tasks {
            retire(task, key: key)
        }
    }

    private func retire(_ task: URLSessionTask, key: String) {
        retired.insert(key)
        responses[key] = nil
        oversized.remove(key)
        task.cancel()
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        let key = key(session, dataTask)
        guard !retired.contains(key), !oversized.contains(key) else { return }
        let existing = responses[key] ?? Data()
        guard existing.count + data.count <= 65_536 else {
            responses[key] = nil
            oversized.insert(key)
            dataTask.cancel()
            return
        }
        responses[key, default: Data()].append(data)
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        let key = key(session, task)
        let data = responses.removeValue(forKey: key) ?? Data()
        let wasOversized = oversized.remove(key) != nil
        guard retired.remove(key) == nil, let identity = task.taskDescription else { return }
        let delivery: Delivery
        if let current = deliveries[identity] {
            guard current.tasks[key] != nil else { return }
            delivery = current
        } else {
            // OS-delivered completions remain valid before React/configuration.
            delivery = Delivery(request: task.originalRequest)
            deliveries[identity] = delivery
        }
        delivery.tasks[key] = nil
        defer { if delivery.tasks.isEmpty { deliveries[identity] = nil } }
        guard !delivery.reported else { return }
        if let error, !wasOversized, !delivery.tasks.isEmpty {
            onAttemptFailure?(identity, error, delivery.attempt)
            return
        }
        delivery.reported = true
        let response = task.response as? HTTPURLResponse
        onCompletion?(identity, response?.statusCode, data, (delivery.attempt, response?.url),
                      wasOversized ? WhoopUploadError(message: "WHOOP upload response exceeds 64 KiB") : error)
    }

    func urlSessionDidFinishEvents(forBackgroundURLSession session: URLSession) { onFinishEvents?() }

    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        // Background URLSession follows redirects without invoking this delegate.
        // The native owner also checks the final response origin on both paths.
        completionHandler(nil)
    }
}
