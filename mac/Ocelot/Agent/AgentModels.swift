import Foundation

/// The sidebar's model list under confinement: the host's `omp models --json` restricted to
/// the chat models the gateway serves. Mirrors `pickerSelectors`/`filterModels` in editor/e2e/agent-sandbox.mjs.
enum AgentModels {
    private static func list(_ models: JSONValue?) -> [JSONValue] {
        if case .object(let object)? = models, case .array(let list)? = object["models"] { return list }
        return []
    }

    private static func selector(_ model: JSONValue) -> String? {
        if case .object(let o) = model, case .string(let s)? = o["selector"] { return s }
        return nil
    }

    private static func isChat(_ model: JSONValue) -> Bool {
        if case .object(let o) = model, case .string(let kind)? = o["kind"] { return kind == "chat" }
        return true
    }

    /// `provider/id` selectors of chat models that both omp lists and the gateway serves.
    static func pickerSelectors(hostModels: JSONValue?, served: [String]) -> [String] {
        let served = Set(served)
        return list(hostModels).filter(isChat).compactMap(selector).filter(served.contains)
    }

    /// `hostModels` with only `selectors` left.
    static func filter(_ hostModels: JSONValue?, selectors: [String]) -> JSONValue {
        let allowed = Set(selectors)
        var object: [String: JSONValue] = [:]
        if case .object(let o)? = hostModels { object = o }
        object["models"] = .array(list(hostModels).filter { selector($0).map(allowed.contains) ?? false })
        return .object(object)
    }

    /// `{ provider: Set }` of the providers in a selector list.
    static func providers(_ selectors: [String]) -> [String] {
        Array(Set(selectors.compactMap { $0.split(separator: "/", maxSplits: 1).first.map(String.init) })).sorted()
    }
}
