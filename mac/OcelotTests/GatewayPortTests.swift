import Darwin
import XCTest
@testable import Ocelot

/// A restarted agent gateway keeps its port: running agents were configured with it and their sandbox only reaches it.
final class GatewayPortTests: XCTestCase {
    func testPrefersTheGivenPortWhenItIsFree() throws {
        let port = try Http.freePort()
        XCTAssertEqual(try Http.freePort(preferring: port), port)
    }

    func testFallsBackToAnotherPortWhenThePreferredOneIsTaken() throws {
        let fd = socket(AF_INET, SOCK_STREAM, 0)
        defer { close(fd) }
        var address = sockaddr_in()
        address.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
        address.sin_family = sa_family_t(AF_INET)
        address.sin_addr.s_addr = inet_addr("127.0.0.1")
        address.sin_port = 0
        _ = withUnsafePointer(to: &address) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.bind(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) } }
        XCTAssertEqual(Darwin.listen(fd, 1), 0)
        var length = socklen_t(MemoryLayout<sockaddr_in>.size)
        _ = withUnsafeMutablePointer(to: &address) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.getsockname(fd, $0, &length) } }
        let taken = Int(UInt16(bigEndian: address.sin_port))

        let port = try Http.freePort(preferring: taken)
        XCTAssertNotEqual(port, taken)
        XCTAssertGreaterThan(port, 0)
    }
}
