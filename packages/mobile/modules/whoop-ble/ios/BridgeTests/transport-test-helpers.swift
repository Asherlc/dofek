import Foundation
import XCTest
@testable import ExpoWhoopBle

extension WhoopURLSessionTransportTests {
    func makeTransport(
        restored: Bool = false,
        requestHeaders: [String: String] = [:],
        makeBackgroundSession: ((URLSessionConfiguration, URLSessionDelegate, OperationQueue) -> URLSession)? = nil,
        handler: @escaping (WhoopTransportURLProtocol) -> Void
    ) throws -> (WhoopURLSessionTransport, URLRequest, URL) {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        addTeardownBlock { try FileManager.default.removeItem(at: directory) }
        let file = directory.appendingPathComponent("body.json")
        try Data("{}".utf8).write(to: file)
        var request = URLRequest(url: URL(string: "https://whoop-transport.invalid/" + UUID().uuidString)!)
        request.httpMethod = "POST"
        for (name, value) in requestHeaders { request.setValue(value, forHTTPHeaderField: name) }
        WhoopTransportURLProtocol.handler = handler
        addTeardownBlock {
            WhoopTransportURLProtocol.handler = nil
            WhoopTransportURLProtocol.stopped = nil
        }
        let transport = WhoopURLSessionTransport { configuration, delegate, queue in
            XCTAssertNil(configuration.httpCookieStorage)
            XCTAssertFalse(configuration.httpShouldSetCookies)
            XCTAssertNil(configuration.urlCredentialStorage)
            XCTAssertNil(configuration.urlCache)
            XCTAssertNotNil(configuration.identifier)
            XCTAssertTrue(configuration.sessionSendsLaunchEvents)
            XCTAssertFalse(configuration.isDiscretionary)
            let test = URLSessionConfiguration.ephemeral
            test.protocolClasses = [WhoopTransportURLProtocol.self]
            test.httpAdditionalHeaders = ["X-Test-Delivery": "background"]
            let session: URLSession
            if let makeBackgroundSession {
                session = makeBackgroundSession(test, delegate, queue)
            } else {
                session = URLSession(configuration: test, delegate: delegate, delegateQueue: queue)
            }
            self.addTeardownBlock { session.invalidateAndCancel() }
            if restored {
                let task = session.uploadTask(with: request, fromFile: file)
                task.taskDescription = "generation.batch"
                task.resume()
            }
            return session
        }
        return (transport, request, file)
    }
}

final class WhoopTransportURLProtocol: URLProtocol {
    private static let lock = NSLock()
    private static var startHandler: ((WhoopTransportURLProtocol) -> Void)?
    private static var stopHandler: ((WhoopTransportURLProtocol) -> Void)?
    static var handler: ((WhoopTransportURLProtocol) -> Void)? {
        get { lock.withLock { startHandler } }
        set { lock.withLock { startHandler = newValue } }
    }
    static var stopped: ((WhoopTransportURLProtocol) -> Void)? {
        get { lock.withLock { stopHandler } }
        set { lock.withLock { stopHandler = newValue } }
    }
    var isBackground: Bool { request.value(forHTTPHeaderField: "X-Test-Delivery") == "background" }
    override static func canInit(with request: URLRequest) -> Bool { true }
    override static func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() { Self.handler?(self) }
    override func stopLoading() { Self.stopped?(self) }
    func succeed(_ data: Data, headers: [String: String] = [:]) {
        let response = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: headers)!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: data)
        client?.urlProtocolDidFinishLoading(self)
    }
}
