import Foundation

/// A failure with a message that says what to do next. `main` prints it as `ocelot: <message>` and exits with `code`.
struct CLIError: Error, CustomStringConvertible {
    var message: String
    var code: Int32 = 1
    var description: String { message }
}

enum Console {
    static func out(_ text: String) { FileHandle.standardOutput.write(Data((text + "\n").utf8)) }
    static func err(_ text: String) { FileHandle.standardError.write(Data((text + "\n").utf8)) }
}

/// Minimal option parser: `--name value`, `--name=value`, boolean flags, positionals, short aliases.
struct Args {
    private(set) var positionals: [String] = []
    private var values: [String: [String]] = [:]
    private var flagSet: Set<String> = []

    /// `valueOptions` take an argument, `flags` do not; `aliases` maps short names (`-o`) to long ones.
    init(_ raw: [String], valueOptions: Set<String> = [], flags: Set<String> = [], aliases: [String: String] = [:]) throws {
        var i = 0
        var onlyPositionals = false
        while i < raw.count {
            var arg = raw[i]
            i += 1
            if onlyPositionals || !arg.hasPrefix("-") || arg == "-" {
                positionals.append(arg)
                continue
            }
            if arg == "--" { onlyPositionals = true; continue }
            if let long = aliases[arg] { arg = long }
            var inline: String?
            if arg.hasPrefix("--"), let eq = arg.firstIndex(of: "=") {
                inline = String(arg[arg.index(after: eq)...])
                arg = String(arg[..<eq])
            }
            if flags.contains(arg) {
                flagSet.insert(arg)
            } else if valueOptions.contains(arg) {
                if let inline {
                    values[arg, default: []].append(inline)
                } else if i < raw.count {
                    values[arg, default: []].append(raw[i])
                    i += 1
                } else {
                    throw CLIError(message: "\(arg) needs a value.", code: 2)
                }
            } else {
                let known = (valueOptions.union(flags)).sorted().joined(separator: " ")
                throw CLIError(message: "Unknown option \(arg). Options for this command: \(known.isEmpty ? "(none)" : known). Run it with --help.", code: 2)
            }
        }
    }

    func flag(_ name: String) -> Bool { flagSet.contains(name) }
    func value(_ name: String) -> String? { values[name]?.last }
    /// Every value of a repeatable option, in order.
    func all(_ name: String) -> [String] { values[name] ?? [] }
}

/// `30s`, `15m`, `1h`, `2d` (a bare number is seconds).
func parseDuration(_ text: String) throws -> TimeInterval {
    let t = text.trimmingCharacters(in: .whitespaces).lowercased()
    guard let last = t.last else { throw CLIError(message: "Empty duration. Use e.g. 30m, 1h or 2d.", code: 2) }
    let unit: Double
    let digits: String
    switch last {
    case "s": (unit, digits) = (1, String(t.dropLast()))
    case "m": (unit, digits) = (60, String(t.dropLast()))
    case "h": (unit, digits) = (3600, String(t.dropLast()))
    case "d": (unit, digits) = (86400, String(t.dropLast()))
    default: (unit, digits) = (1, t)
    }
    guard let n = Double(digits), n > 0, n.isFinite else { throw CLIError(message: "\"\(text)\" is not a duration. Use e.g. 30m, 1h or 2d.", code: 2) }
    return n * unit
}

enum JSON {
    static func object(_ data: Data) -> [String: Any]? { (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] }

    static func encode(_ value: Any, pretty: Bool = false) -> Data {
        var options: JSONSerialization.WritingOptions = [.sortedKeys, .withoutEscapingSlashes]
        if pretty { options.insert(.prettyPrinted) }
        return (try? JSONSerialization.data(withJSONObject: value, options: options)) ?? Data("null".utf8)
    }

    static func string(_ value: Any, pretty: Bool = false) -> String { String(decoding: encode(value, pretty: pretty), as: UTF8.self) }
}
