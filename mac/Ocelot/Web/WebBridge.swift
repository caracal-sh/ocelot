import Foundation
import WebKit

/// Connects the bridge core to a WKWebView:
/// - TS -> Swift: `window.webkit.messageHandlers.<messageHandler>.postMessage(json)`,
///   answered through WKScriptMessageHandlerWithReply (the JS promise resolves with our reply).
/// - Swift -> TS: `callAsyncJavaScript` invoking `window.<editorGlobal>.dispatch(json)`.
@MainActor
final class WebBridge: NSObject {
    let host = HostEndpoint()
    weak var webView: WKWebView?

    private(set) lazy var editor = EditorClient { [weak self] json in
        guard let webView = self?.webView else {
            throw BridgeFailure(.hostUnavailable, "The editor window is closed. Open a document window and retry.")
        }
        return try await WebBridge.dispatchToEditor(webView, json)
    }

    /// What a call gets when the editor page is (re)loading and has not installed its endpoint yet.
    static let pageLoadingMessage = "Editor endpoint is not installed yet (page still loading)."

    /// True when `error` only means the page was reloading (dev reload, web process restart): the next
    /// `editorDidLoad` gets another chance, so callers should not show it as a failure.
    static func isPageLoading(_ error: any Error) -> Bool {
        (error as? BridgeFailure)?.message.hasSuffix(pageLoadingMessage) == true
    }

    private static func dispatchToEditor(_ webView: WKWebView, _ json: String) async throws -> String {
        try await withCheckedThrowingContinuation { (cont: CheckedContinuation<String, any Error>) in
            webView.callAsyncJavaScript(
                """
                const endpoint = window[name];
                if (!endpoint || typeof endpoint.dispatch !== 'function') {
                  throw new Error(loading);
                }
                return await endpoint.dispatch(json);
                """,
                arguments: ["name": BridgeSchema.editorGlobal, "json": json, "loading": pageLoadingMessage],
                in: nil,
                in: .page
            ) { result in
                switch result {
                case .success(let value):
                    if let s = value as? String {
                        cont.resume(returning: s)
                    } else {
                        cont.resume(throwing: BridgeFailure(.internal, "Editor returned a non-string payload."))
                    }
                case .failure(let error):
                    // WebKit's description is only "A JavaScript exception occurred"; the page's message is in userInfo.
                    if let message = (error as NSError).userInfo["WKJavaScriptExceptionMessage"] as? String {
                        cont.resume(throwing: BridgeFailure(.hostUnavailable, "The editor page threw: \(message)"))
                    } else {
                        cont.resume(throwing: error)
                    }
                }
            }
        }
    }
}

extension WebBridge: WKScriptMessageHandlerWithReply {
    func userContentController(
        _ userContentController: WKUserContentController,
        didReceive message: WKScriptMessage
    ) async -> (Any?, String?) {
        // Artboard iframes are same-origin and could reach window.webkit. Only the
        // editor's top-level document may talk to the host.
        guard message.frameInfo.isMainFrame else {
            return (nil, "Bridge calls are only accepted from the editor's main frame.")
        }
        guard let body = message.body as? String else {
            return (nil, "Bridge messages must be JSON strings.")
        }
        let reply = await host.dispatch(body)
        return (reply, nil)
    }
}
