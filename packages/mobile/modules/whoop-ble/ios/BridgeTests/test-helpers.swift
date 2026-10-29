@testable import ExpoModulesCore
import ExpoModulesTestCore
import XCTest
@testable import ExpoWhoopBle

var captureError: NSError {
    NSError(domain: "CaptureTest", code: 1, userInfo: [
        NSLocalizedDescriptionKey: "The capture database is unavailable"
    ])
}

func makeModule() throws -> (TestAppContext, WhoopBleModule) {
    let context = TestAppContext()
    context.registerNativeModules(provider: WhoopBridgeModulesProvider())
    let module = try XCTUnwrap(context.moduleRegistry.get(moduleWithName: "WhoopBle") as? WhoopBleModule)
    return (context, module)
}

func outcome(_ call: String, in context: TestAppContext) async throws -> String {
    let runtime = try context.runtime
    let result = try await runtime.evalAsync("""
        expo.modules.WhoopBle.\(call).then(
            () => 'unexpected success',
            error => error.code + ': ' + error.message
        )
        """).ref()
    return try await runtime.execute { try result.take().asString() }
}

private final class WhoopBridgeModulesProvider: ModulesProvider {
    override func getModuleClasses() -> [ExpoModuleTupleType] {
        [(WhoopBleModule.self, "WhoopBle")]
    }
}
