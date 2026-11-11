import Foundation
import Security

/// What a scoped token may reach.
enum MCPScope: Equatable, Sendable {
    case window(String)
    case project(String)
}

/// The outcome of authenticating a bearer token.
struct MCPGrant: Equatable, Sendable {
    /// nil = master token (any window or project).
    var scope: MCPScope?
    var readOnly: Bool

    static let master = MCPGrant(scope: nil, readOnly: false)

    /// Whether this grant may act on the window/project a request resolved to.
    /// `windowId` is nil for projects hosted elsewhere (headless host, container).
    func permits(windowId: String?, projectId: String?) -> Bool {
        switch scope {
        case nil: true
        case .window(let id)?: windowId == id
        case .project(let id)?: projectId == id
        }
    }
}

/// The master token plus in-memory scoped tokens. Scoped tokens never touch disk: they die with the app.
final class MCPTokenStore {
    private struct Scoped {
        var grant: MCPGrant
        var expires: Date?
    }

    private(set) var master: String
    private var scoped: [String: Scoped] = [:]
    private let now: () -> Date

    init(master: String, now: @escaping () -> Date = Date.init) {
        self.master = master
        self.now = now
    }

    func setMaster(_ token: String) { master = token }

    func issue(scope: MCPScope, readOnly: Bool, ttl: Duration?) -> String {
        purgeExpired()
        let token = Self.generate()
        let expires = ttl.map { now().addingTimeInterval(Double($0.components.seconds) + Double($0.components.attoseconds) / 1e18) }
        scoped[token] = Scoped(grant: MCPGrant(scope: scope, readOnly: readOnly), expires: expires)
        return token
    }

    func revoke(_ token: String) { scoped[token] = nil }

    /// Revokes every scoped token for a scope (a sidebar conversation ended, a window closed).
    func revokeAll(scope: MCPScope) { scoped = scoped.filter { $0.value.grant.scope != scope } }

    func purgeExpired() {
        let t = now()
        scoped = scoped.filter { ($0.value.expires ?? .distantFuture) > t }
    }

    /// `Authorization` header value (`Bearer <token>`) -> grant; nil when missing, wrong, revoked or expired.
    func authorize(_ header: String?) -> MCPGrant? {
        guard let header, header.hasPrefix("Bearer ") else { return nil }
        let presented = String(header.dropFirst(7))
        // Compare against every candidate in constant time per comparison; the table is tiny.
        var found: MCPGrant?
        if MCPRequestValidator.constantTimeEquals(presented, master) { found = .master }
        let t = now()
        for (token, entry) in scoped where MCPRequestValidator.constantTimeEquals(presented, token) {
            if let exp = entry.expires, exp <= t { continue }
            found = entry.grant
        }
        return found
    }

    static func generate() -> String {
        var bytes = [UInt8](repeating: 0, count: 32)
        if SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) != errSecSuccess {
            return (UUID().uuidString + UUID().uuidString).replacingOccurrences(of: "-", with: "").lowercased()
        }
        return bytes.map { String(format: "%02x", $0) }.joined()
    }
}
