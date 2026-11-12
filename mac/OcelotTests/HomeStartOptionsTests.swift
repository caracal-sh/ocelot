import XCTest
@testable import Ocelot

@MainActor
final class HomeStartOptionsTests: XCTestCase {
    private var dir: URL!

    override func setUpWithError() throws {
        dir = FileManager.default.temporaryDirectory.appendingPathComponent("ocelot-home-options-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        setenv("OCELOT_RECOVERY_DIR", dir.appendingPathComponent("Recovery").path, 1)
    }

    override func tearDown() {
        unsetenv("OCELOT_RECOVERY_DIR")
        try? FileManager.default.removeItem(at: dir)
    }

    private final class Box: @unchecked Sendable { var params: JSONValue? }

    /// An editor that records the params of `editor.startWithPrompt`.
    private func recordingEditor(_ box: Box) -> EditorClient {
        EditorClient { json in
            let req = try JSONDecoder().decode(BridgeRequestEnvelope.self, from: Data(json.utf8))
            if req.method == EditorMethods.StartWithPrompt.name { box.params = req.params }
            let result: JSONValue = req.method == EditorMethods.StartWithPrompt.name ? .object(["started": .bool(true)]) : .object([:])
            return BridgeCoding.string(BridgeResponseEnvelope(v: BridgeSchema.version, id: req.id, ok: true, result: result, error: nil))
        }
    }

    func testHomeChoicesBecomeOptions() {
        XCTAssertEqual(HomeStartOptions(styleID: "", planFirst: false), HomeStartOptions())
        XCTAssertEqual(HomeStartOptions(styleID: "not-a-style", planFirst: true), HomeStartOptions(designSystem: nil, planFirst: true))
        XCTAssertEqual(HomeStartOptions(styleID: "luma", planFirst: true), HomeStartOptions(designSystem: .object(["style": .string("luma")]), planFirst: true))
        XCTAssertEqual(HomeDesignStyle.allCases.map(\.rawValue), ["nova", "vega", "maia", "lyra", "mira", "luma", "rhea", "sera"])
        XCTAssertEqual(HomeDesignStyle.sera.title, "Sera")
    }

    func testChoicesAreRememberedUnderTheirKeys() {
        XCTAssertEqual(HomeDesignStyle.defaultsKey, "ocelot.home.designSystem")
        XCTAssertEqual(HomeDesignStyle.planFirstKey, "ocelot.home.planFirst")
    }

    func testARequestWithoutOptionsIsTheOldPlainStart() {
        XCTAssertEqual(HomeCoordinator.Request.prompt("x", []), .prompt("x", [], HomeStartOptions()))
        XCTAssertNotEqual(HomeCoordinator.Request.prompt("x", []), .prompt("x", [], HomeStartOptions(planFirst: true)))
    }

    /// Style and plan first travel with the prompt to `editor.startWithPrompt`.
    func testTheNewDocumentStartsTheAgentWithTheDesignSystemAndPlanFirst() async throws {
        let box = Box()
        let client = recordingEditor(box)
        let session = DocumentSession(editor: { client })
        session.prepareFresh(prompt: "A pricing page", options: HomeStartOptions(styleID: "luma", planFirst: true))
        await session.editorDidLoad()
        for _ in 0..<100 where box.params == nil { try await Task.sleep(for: .milliseconds(20)) }
        let params = try BridgeCoding.decode(StartWithPromptParams.self, from: try XCTUnwrap(box.params))
        XCTAssertEqual(params.prompt, "A pricing page")
        XCTAssertEqual(params.designSystem, .object(["style": .string("luma")]))
        XCTAssertEqual(params.planFirst, true)
    }

    /// With nothing chosen the params are exactly what they were before the options existed.
    func testNothingChosenSendsNeitherField() async throws {
        let box = Box()
        let client = recordingEditor(box)
        let session = DocumentSession(editor: { client })
        session.prepareFresh(prompt: "A page")
        await session.editorDidLoad()
        for _ in 0..<100 where box.params == nil { try await Task.sleep(for: .milliseconds(20)) }
        let params = try BridgeCoding.decode(StartWithPromptParams.self, from: try XCTUnwrap(box.params))
        XCTAssertNil(params.designSystem)
        XCTAssertNil(params.planFirst)
    }

    /// `startAgent` (new_project after it set the project up) carries both too.
    func testStartAgentCarriesTheOptions() async throws {
        let box = Box()
        let client = recordingEditor(box)
        let session = DocumentSession(editor: { client }, isEditorReady: true)
        await session.startAgent(with: "Brief", attachments: [], options: HomeStartOptions(designSystem: .object(["style": .string("nova"), "radius": .string("large")]), planFirst: true))
        let params = try BridgeCoding.decode(StartWithPromptParams.self, from: try XCTUnwrap(box.params))
        XCTAssertEqual(params.planFirst, true)
        XCTAssertEqual(params.designSystem, .object(["style": .string("nova"), "radius": .string("large")]))
    }
}
