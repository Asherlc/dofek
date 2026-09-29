import Foundation

@main
struct AppleAuthenticationErrorDiagnosticsTests {
  static func main() {
    let secret = "synthetic-private-token@example.test"
    let underlying = NSError(domain: "AKAuthenticationError", code: -7026, userInfo: [
      NSLocalizedDescriptionKey: secret,
      NSUnderlyingErrorKey: NSError(domain: secret, code: 123)
    ])
    let original = NSError(domain: "com.apple.AuthenticationServices.AuthorizationError", code: 1000, userInfo: [
      NSLocalizedDescriptionKey: secret,
      NSUnderlyingErrorKey: underlying,
      "token": secret
    ])
    let diagnostic = AppleAuthenticationErrorDiagnostics(original)
    precondition(diagnostic.localizedDescription == "[dofek.apple-auth domain=com.apple.AuthenticationServices.AuthorizationError code=1000 underlyingDomain=AKAuthenticationError underlyingCode=-7026]")
    precondition(!String(reflecting: diagnostic).contains(secret))
    precondition(!diagnostic.localizedDescription.contains(secret))
    for domain in ["NSCocoaErrorDomain", "NSPOSIXErrorDomain", "NSURLErrorDomain", "AKAuthenticationError", "com.apple.AuthenticationServices.AuthorizationError"] {
      let value = AppleAuthenticationErrorDiagnostics(NSError(domain: domain, code: 42))
      precondition(value.localizedDescription == "[dofek.apple-auth domain=\(domain) code=42]")
    }
    for userInfo: [String: Any] in [[:], [NSUnderlyingErrorKey: secret]] {
      let value = AppleAuthenticationErrorDiagnostics(NSError(domain: secret, code: -1, userInfo: userInfo))
      precondition(value.localizedDescription == "[dofek.apple-auth domain=other code=-1]")
    }
    let unknownUnderlying = AppleAuthenticationErrorDiagnostics(NSError(domain: secret, code: 1, userInfo: [
      NSUnderlyingErrorKey: NSError(domain: secret, code: 2, userInfo: [NSLocalizedDescriptionKey: secret])
    ]))
    precondition(unknownUnderlying.localizedDescription == "[dofek.apple-auth domain=other code=1 underlyingDomain=other underlyingCode=2]")
    // Prove the immutable diagnostic does not retain the source NSError/userInfo.
    weak var weakError: NSError?
    var retainedDiagnostic: AppleAuthenticationErrorDiagnostics?
    autoreleasepool {
      let error = NSError(domain: "NSCocoaErrorDomain", code: 513, userInfo: ["token": secret])
      weakError = error
      retainedDiagnostic = AppleAuthenticationErrorDiagnostics(error)
    }
    precondition(weakError == nil)
    precondition(retainedDiagnostic?.localizedDescription == "[dofek.apple-auth domain=NSCocoaErrorDomain code=513]")
    print("Apple native diagnostics: classification, redaction, underlying errors, and non-retention passed.")
  }
}
