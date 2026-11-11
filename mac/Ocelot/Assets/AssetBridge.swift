import AppKit
import Foundation

/// `host.assets*`, `host.image*` and `host.exportSave` for one editor window.
@MainActor
enum AssetBridge {
    static func register(on host: HostEndpoint, session: DocumentSession, hub: ImageProviderHub = .shared) {
        let store = session.assets
        let images = ImageService(store: store, hub: hub, editor: { [weak session] in session?.editorClient() }, document: { [weak session] in session?.binding })
        session.onDocumentReplaced = { images.cancelAll() }

        host.register(HostMethods.AssetsList.self) { _ in
            AssetList(assets: try await store.list())
        }
        host.register(HostMethods.AssetsRead.self) { params in
            let (record, data) = try await store.read(params.id)
            return AssetData(id: record.id, mime: record.mime, base64: data.base64EncodedString())
        }
        host.register(HostMethods.AssetsImport.self) { params in
            guard let data = decodeBase64(params.base64) else {
                throw BridgeFailure(.invalidParams, "`base64` is not valid base64. Pass the raw base64 of the image file (a data: URL prefix is accepted).")
            }
            let seed = params.params.flatMap(Self.seed(in:))
            let meta = AssetMetadata(
                name: params.name, kind: params.kind ?? "upload", prompt: params.prompt, provider: params.provider,
                model: params.model, seed: seed, sources: params.sources, params: params.params
            )
            return try await store.importData(data, meta)
        }
        host.register(HostMethods.AssetsDelete.self) { params in
            AssetList(assets: try await store.delete(params.ids))
        }

        host.register(HostMethods.ImageProviders.self) { _ in await images.providers() }
        host.register(HostMethods.ImageGenerate.self) { params in try await images.generate(params) }
        host.register(HostMethods.ImageCancel.self) { params in
            images.cancel(requestId: params.requestId)
            return Empty()
        }
        host.register(HostMethods.ImageSetKey.self) { params in
            try await hub.setKey(provider: params.provider, key: params.key)
        }
        host.register(HostMethods.ImageSetDefault.self) { params in
            try await hub.setDefault(params.model)
        }

        host.register(HostMethods.ExportSave.self) { params in
            try await exportSave(params, store: store)
        }
    }

    /// Raw base64, or a `data:` URL.
    nonisolated static func decodeBase64(_ input: String) -> Data? {
        var text = input
        if text.hasPrefix("data:"), let comma = text.firstIndex(of: ",") { text = String(text[text.index(after: comma)...]) }
        return Data(base64Encoded: text, options: .ignoreUnknownCharacters)
    }

    /// A `seed` carried in `params` (the editor puts it there for imported results).
    private static func seed(in params: JSONValue) -> Int? {
        guard case .object(let object) = params, case .number(let n)? = object["seed"], n == n.rounded(), abs(n) < 1e15 else { return nil }
        return Int(n)
    }

    // MARK: Export

    private static func exportSave(_ params: ExportSaveParams, store: AssetStore) async throws -> ExportSaveResult {
        let name = try ExportWriter.validateName(params.name)
        let files = try ExportWriter.validate(params.files)
        // Resolve every asset before asking the user for a folder, so mistakes fail without UI.
        var assetFiles: [String: URL] = [:]
        for case .asset(let id) in files.map(\.content) where assetFiles[id] == nil {
            assetFiles[id] = try await store.fileURL(id)
        }

        let panel = NSOpenPanel()
        panel.canChooseFiles = false
        panel.canChooseDirectories = true
        panel.canCreateDirectories = true
        panel.allowsMultipleSelection = false
        panel.message = "Choose where to save the export folder “\(name)”."
        panel.prompt = "Export Here"
        guard panel.runModal() == .OK, let chosen = panel.url else {
            return ExportSaveResult(path: "", cancelled: true)
        }
        let resolved = assetFiles
        let fontsRoot = EditorSource.bundleRoot?.appendingPathComponent("fonts", isDirectory: true)
        do {
            let folder = try await Task.detached { try ExportWriter.write(into: chosen, name: name, files: files, assetFiles: resolved, fontsRoot: fontsRoot) }.value
            return ExportSaveResult(path: folder.path, cancelled: nil)
        } catch let failure as BridgeFailure {
            throw failure
        } catch {
            throw BridgeFailure(.internal, "Could not write the export into \(chosen.path): \(error.localizedDescription). Choose another folder.")
        }
    }
}
