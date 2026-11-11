import Foundation

/// State of Settings > Images: the provider list, the default model and the fal key. It reads and writes the
/// shared `ImageProviderHub`, so the editor's Assets > Providers dialog and this tab always agree: a change made
/// in either is announced through the hub's observers and reloaded here.
@MainActor
final class ImageSettingsModel: ObservableObject {
    static let shared = ImageSettingsModel()

    /// The `Picker` tag of "Automatic (first available)".
    static let automaticTag = ""

    @Published private(set) var providers: [ImageProviderInfo] = []
    @Published private(set) var defaultModel: String?
    @Published private(set) var isRefreshing = false
    /// The last failure to store or remove a key or to save the default, phrased with the next step.
    @Published var message: String?

    private let hub: ImageProviderHub
    private var observation: ImageProviderObservation?
    /// The reload started by the latest hub change; tests await it.
    private(set) var pendingReload: Task<Void, Never>?

    init(hub: ImageProviderHub = .shared) {
        self.hub = hub
        defaultModel = hub.defaultModel
        observation = hub.addObserver { [weak self] in self?.hubChanged() }
    }

    // MARK: Derived

    /// Providers that offer at least one model, for the picker's sections.
    var modelGroups: [ImageProviderInfo] { providers.filter { !$0.models.isEmpty } }

    func model(_ id: String) -> ImageModelInfo? {
        providers.lazy.flatMap(\.models).first { $0.id == id }
    }

    /// The persisted default when it names a model the catalogs do not list (a custom `fal:<endpoint>`): the
    /// picker still has to show it as the current choice.
    var customDefault: String? {
        guard let defaultModel, model(defaultModel) == nil else { return nil }
        return defaultModel
    }

    /// `nil` (automatic) and every available catalog model can be chosen; unavailable ones cannot.
    func isSelectable(_ id: String?) -> Bool {
        guard let id else { return true }
        return model(id)?.available == true
    }

    /// Picker selection: the model id, or `automaticTag`.
    var selectionTag: String { defaultModel ?? Self.automaticTag }

    /// "text, edit, transparent": the capabilities worth showing next to a model.
    static func capabilityHint(_ model: ImageModelInfo) -> String {
        let names: [(String, String)] = [
            ("generate", "text"), ("references", "references"), ("edit", "edit"), ("mask", "mask"),
            ("transparent", "transparent"), ("remove_background", "cut-out"),
        ]
        return names.filter { model.capabilities.contains($0.0) }.map(\.1).joined(separator: ", ")
    }

    // MARK: Actions

    func reload() async {
        apply(await hub.list())
    }

    /// Asks every provider again (`infos(force: true)`): picks up a login or key made outside the app and clears a
    /// credential the hub marked as rejected.
    func refresh() async {
        isRefreshing = true
        defer { isRefreshing = false }
        apply(await hub.list(force: true))
    }

    /// Persists the default through the hub (the same `ocelot.image.defaultModel` the editor uses). Unavailable
    /// models are refused.
    func select(_ tag: String) async {
        let id = tag == Self.automaticTag ? nil : tag
        guard isSelectable(id) else {
            if let id, let reason = model(id)?.unavailableReason { message = "\(id) is not available: \(reason)" }
            return
        }
        do {
            message = nil
            apply(try await hub.setDefault(id))
        } catch {
            message = Self.describe(error)
        }
    }

    /// Stores (`key`) or removes (`nil`) the fal key in the Keychain. The key is not kept here.
    @discardableResult
    func setFalKey(_ key: String?) async -> Bool {
        do {
            message = nil
            apply(try await hub.setKey(provider: "fal", key: key))
            return true
        } catch {
            message = Self.describe(error)
            return false
        }
    }

    // MARK: Internals

    private func hubChanged() {
        pendingReload = Task { [weak self] in await self?.reload() }
    }

    private func apply(_ list: ImageProviderList) {
        providers = list.providers
        defaultModel = list.defaultModel
    }

    private static func describe(_ error: any Error) -> String {
        (error as? BridgeFailure)?.message ?? error.localizedDescription
    }
}
