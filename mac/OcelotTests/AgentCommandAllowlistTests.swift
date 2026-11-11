import XCTest
@testable import Ocelot

/// The RPC commands the sidebar may write to its omp process. editor/e2e/omp-runner.test.mjs checks that the headless host's list is the same.
@MainActor
final class AgentCommandAllowlistTests: XCTestCase {
    func testQueueCommandsAreAllowed() {
        for type in ["prompt", "abort", "remove_queued_message", "promote_queued_message", "abort_and_restore_queue"] {
            XCTAssertTrue(AgentRunner.allowedCommands.contains(type), type)
        }
    }

    func testShellAndSessionCommandsAreStillRefused() {
        for type in ["bash", "login", "switch_session", "open_session", "steer", "follow_up"] {
            XCTAssertFalse(AgentRunner.allowedCommands.contains(type), type)
        }
    }
}
