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
        let taken = try listen(on: fd)

        let port = try Http.freePort(preferring: taken)
        XCTAssertNotEqual(port, taken)
        XCTAssertGreaterThan(port, 0)
    }

    /// The gateway dies with agents connected: its port then has connections in TIME_WAIT, and the restart must still get it back.
    func testReusesThePreferredPortWhoseOnlyUseIsAConnectionInTimeWait() throws {
        let listener = socket(AF_INET, SOCK_STREAM, 0)
        var reuse: Int32 = 1
        XCTAssertEqual(setsockopt(listener, SOL_SOCKET, SO_REUSEADDR, &reuse, socklen_t(MemoryLayout<Int32>.size)), 0)
        let port = try listen(on: listener)

        let client = socket(AF_INET, SOCK_STREAM, 0)
        defer { close(client) }
        var address = loopback(port)
        let connected = withUnsafePointer(to: &address) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.connect(client, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) }
        }
        XCTAssertEqual(connected, 0)
        let accepted = Darwin.accept(listener, nil, nil)
        XCTAssertGreaterThanOrEqual(accepted, 0)
        close(accepted) // the server side closes first, so it is the side that waits in TIME_WAIT
        close(listener)

        XCTAssertEqual(try Http.freePort(preferring: port), port)
    }

    private func loopback(_ port: Int) -> sockaddr_in {
        var address = sockaddr_in()
        address.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
        address.sin_family = sa_family_t(AF_INET)
        address.sin_addr.s_addr = inet_addr("127.0.0.1")
        address.sin_port = in_port_t(UInt16(port).bigEndian)
        return address
    }

    /// Binds `fd` to a free loopback port, listens, and returns the port.
    private func listen(on fd: Int32) throws -> Int {
        var address = loopback(0)
        let bound = withUnsafePointer(to: &address) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.bind(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) } }
        XCTAssertEqual(bound, 0)
        XCTAssertEqual(Darwin.listen(fd, 1), 0)
        var length = socklen_t(MemoryLayout<sockaddr_in>.size)
        _ = withUnsafeMutablePointer(to: &address) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.getsockname(fd, $0, &length) } }
        return Int(UInt16(bigEndian: address.sin_port))
    }
}
