import Foundation
import UniformTypeIdentifiers
import WebKit

/// Where the editor UI is loaded from.
enum EditorSource {
    /// Custom scheme for the bundled editor: ocelot://app/index.html.
    /// Gives the editor a stable, non-file origin, so ES modules and same-origin
    /// srcdoc iframes behave like on a normal web origin.
    static let scheme = "ocelot"
    static let bundleURL = URL(string: "\(scheme)://app/index.html")!

    /// Debug builds load the Vite dev server when OCELOT_DEV_URL is set
    /// (`make dev`, or the Xcode scheme's environment). Release ignores it.
    static var devURL: URL? {
        #if DEBUG
        if let raw = ProcessInfo.processInfo.environment["OCELOT_DEV_URL"], !raw.isEmpty, let url = URL(string: raw) {
            return url
        }
        #endif
        return nil
    }

    /// Built editor, copied by XcodeGen as a folder reference: Contents/Resources/dist.
    static var bundleRoot: URL? {
        Bundle.main.resourceURL?.appendingPathComponent("dist", isDirectory: true)
    }
}

/// Serves files from the bundled editor directory for the `ocelot://` scheme.
@MainActor
final class EditorSchemeHandler: NSObject {
    private let root: URL?

    init(root: URL?) {
        self.root = root?.standardizedFileURL
    }

    nonisolated private static let mimeTypes: [String: String] = [
        "html": "text/html; charset=utf-8",
        "js": "text/javascript; charset=utf-8",
        "mjs": "text/javascript; charset=utf-8",
        "css": "text/css; charset=utf-8",
        "json": "application/json; charset=utf-8",
        "map": "application/json; charset=utf-8",
        "svg": "image/svg+xml",
        "wasm": "application/wasm",
        "woff2": "font/woff2",
    ]

    nonisolated static func mimeType(for url: URL) -> String {
        let ext = url.pathExtension.lowercased()
        if let known = mimeTypes[ext] { return known }
        return UTType(filenameExtension: ext)?.preferredMIMEType ?? "application/octet-stream"
    }

    /// Resolves a request path inside `root`, refusing anything that escapes it.
    nonisolated static func resolve(path rawPath: String, in root: URL) -> URL? {
        var path = rawPath.removingPercentEncoding ?? rawPath
        if path.isEmpty || path == "/" { path = "/index.html" }
        let candidate = root.appendingPathComponent(String(path.drop(while: { $0 == "/" }))).standardizedFileURL
        let rootPath = root.path.hasSuffix("/") ? root.path : root.path + "/"
        return candidate.path.hasPrefix(rootPath) ? candidate : nil
    }

    private static let missingBundleHTML = """
    <!doctype html><meta charset="utf-8"><title>Ocelot</title>
    <body style="font: 13px -apple-system; padding: 40px; color: #888">
    <h3>Editor bundle not found</h3>
    <p>The app was built without the editor. Run <code>make build</code> (it builds <code>editor/dist</code> first),
    or run <code>make dev</code> to use the Vite dev server.</p></body>
    """
}

extension EditorSchemeHandler: WKURLSchemeHandler {
    func webView(_ webView: WKWebView, start urlSchemeTask: any WKURLSchemeTask) {
        guard let url = urlSchemeTask.request.url else {
            urlSchemeTask.didFailWithError(URLError(.badURL))
            return
        }
        let isIndex = url.path.isEmpty || url.path == "/" || url.path == "/index.html"

        guard let root, let fileURL = Self.resolve(path: url.path, in: root),
              let data = try? Data(contentsOf: fileURL)
        else {
            let body = isIndex ? Data(Self.missingBundleHTML.utf8) : Data("Not found".utf8)
            respond(urlSchemeTask, url: url, status: 404, mime: isIndex ? "text/html; charset=utf-8" : "text/plain", data: body)
            return
        }
        respond(urlSchemeTask, url: url, status: 200, mime: Self.mimeType(for: fileURL), data: data)
    }

    func webView(_ webView: WKWebView, stop urlSchemeTask: any WKURLSchemeTask) {
        // Responses are delivered synchronously in start(); nothing to cancel.
    }

    private func respond(_ task: any WKURLSchemeTask, url: URL, status: Int, mime: String, data: Data) {
        var headers = [
            "Content-Type": mime,
            "Content-Length": String(data.count),
            "Cache-Control": "no-cache",
        ]
        // Code layers run in a sandboxed frame with an opaque origin (`Origin: null`) and
        // import the vendored libraries as CORS module requests. Only /vendor/ is opened up.
        if url.path.hasPrefix("/vendor/") { headers["Access-Control-Allow-Origin"] = "*" }
        guard let response = HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1", headerFields: headers) else {
            task.didFailWithError(URLError(.cannotParseResponse))
            return
        }
        task.didReceive(response)
        task.didReceive(data)
        task.didFinish()
    }
}
