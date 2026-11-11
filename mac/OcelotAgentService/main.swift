import Foundation

/// Embedded, sandboxed XPC service that owns the sidebar agent's omp process
/// (entitlements: app-sandbox, network.client, read-only access to omp's install directory).
/// It cannot read the user's ~/.omp, ~/.ssh or documents; the model credentials stay in the app's gateway.
final class ServiceDelegate: NSObject, NSXPCListenerDelegate, @unchecked Sendable {
    func listener(_ listener: NSXPCListener, shouldAcceptNewConnection connection: NSXPCConnection) -> Bool {
        // Bundled services are only visible to their containing app; still insist on it.
        connection.setCodeSigningRequirement("identifier \"sh.caracal.ocelot\"")
        connection.exportedInterface = NSXPCInterface(with: OcelotAgentServiceProtocol.self)
        connection.remoteObjectInterface = NSXPCInterface(with: OcelotAgentClientProtocol.self)
        let service = AgentProcessService(connection: connection)
        connection.exportedObject = service
        // The app quit, crashed or lost the connection: omp must not outlive it.
        connection.invalidationHandler = { service.stopAll() }
        connection.interruptionHandler = { service.stopAll() }
        connection.resume()
        return true
    }
}

let delegate = ServiceDelegate()
let listener = NSXPCListener.service()
listener.delegate = delegate
listener.resume()
