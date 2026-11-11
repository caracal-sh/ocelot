import Foundation

/// Links the editor may hand to the system (`host.openURL`): web pages and mail. Everything else
/// (`javascript:`, `file:`, `data:`, `ocelot:`, custom app schemes) is refused, so a prototype link in a
/// document can never launch another app or read a local file.
enum ExternalURL {
    static let allowedSchemes: Set<String> = ["http", "https", "mailto"]

    private static let hint = "Only http, https and mailto links can be opened. Use a link like https://example.com or mailto:name@example.com."

    /// Returns the URL to open, or throws a `.invalidParams` failure that says what to pass instead.
    static func validated(_ string: String) throws -> URL {
        let trimmed = string.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            throw BridgeFailure(.invalidParams, "The link is empty. \(hint)")
        }
        guard let components = URLComponents(string: trimmed), let url = components.url, let scheme = components.scheme?.lowercased() else {
            throw BridgeFailure(.invalidParams, "\"\(trimmed)\" is not a valid link. \(hint)")
        }
        guard allowedSchemes.contains(scheme) else {
            throw BridgeFailure(.invalidParams, "\"\(scheme):\" links are not allowed. \(hint)")
        }
        switch scheme {
        case "mailto":
            // The address is everything before the query (`mailto:a@b.c?subject=Hi`).
            guard !components.path.trimmingCharacters(in: .whitespaces).isEmpty else {
                throw BridgeFailure(.invalidParams, "The mailto link has no address. Use a link like mailto:name@example.com.")
            }
        default:
            guard let host = components.host, !host.isEmpty else {
                throw BridgeFailure(.invalidParams, "\"\(trimmed)\" has no host. Use a full link like https://example.com/page.")
            }
        }
        return url
    }
}
