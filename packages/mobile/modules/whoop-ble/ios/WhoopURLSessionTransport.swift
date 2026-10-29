import Foundation

/// URLSession's delegate queue is serial; completion is enqueued before finish-events.
final class WhoopURLSessionTransport: NSObject, WhoopUploadTransport, URLSessionDataDelegate {
    var onCompletion: ((String, Int?, Data, URL?, Error?) -> Void)?
    var onFinishEvents: (() -> Void)?
    private var responses: [Int: Data] = [:]
    private var oversized = Set<Int>()
    private lazy var session: URLSession = {
        #if os(iOS)
        let configuration = URLSessionConfiguration.background(withIdentifier: WhoopBleUploadRuntime.sessionIdentifier)
        configuration.sessionSendsLaunchEvents = true
        configuration.isDiscretionary = false
        #else
        let configuration = URLSessionConfiguration.default
        #endif
        configuration.httpCookieStorage = nil
        configuration.httpShouldSetCookies = false
        configuration.urlCredentialStorage = nil
        configuration.urlCache = nil
        let delegates = OperationQueue()
        delegates.maxConcurrentOperationCount = 1
        return URLSession(configuration: configuration, delegate: self, delegateQueue: delegates)
    }()

    func allTasks(_ completion: @escaping ([String]) -> Void) {
        session.getAllTasks { tasks in
            completion(tasks.filter { $0.state != .completed && $0.state != .canceling }.compactMap(\.taskDescription))
        }
    }

    func start(request: URLRequest, file: URL, identity: String) {
        let task = session.uploadTask(with: request, fromFile: file)
        task.taskDescription = identity
        task.resume()
    }

    func cancel(identity: String) {
        session.getAllTasks { tasks in tasks.filter { $0.taskDescription == identity }.forEach { $0.cancel() } }
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        guard !oversized.contains(dataTask.taskIdentifier) else { return }
        let existing = responses[dataTask.taskIdentifier] ?? Data()
        guard existing.count + data.count <= 65_536 else {
            responses[dataTask.taskIdentifier] = nil
            oversized.insert(dataTask.taskIdentifier)
            dataTask.cancel()
            return
        }
        responses[dataTask.taskIdentifier, default: Data()].append(data)
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        let data = responses.removeValue(forKey: task.taskIdentifier) ?? Data()
        let wasOversized = oversized.remove(task.taskIdentifier) != nil
        guard let identity = task.taskDescription else { return }
        let response = task.response as? HTTPURLResponse
        onCompletion?(identity, response?.statusCode, data, response?.url,
                      wasOversized ? WhoopUploadError(message: "WHOOP upload response exceeds 64 KiB") : error)
    }

    func urlSessionDidFinishEvents(forBackgroundURLSession session: URLSession) { onFinishEvents?() }

    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        // Background URLSession follows redirects without invoking this delegate method.
        // Canonical server mutation URLs must serve directly; this also protects the macOS adapter.
        completionHandler(nil)
    }
}
