import CryptoKit
import Foundation
import Testing
@testable import OpenCodeKit

/// The engine's download, from a server on this Mac that drops the connection or refuses.
@Suite(.serialized)
struct EngineDownloadTests {
    /// A server on 127.0.0.1 that answers each request in turn as `answers` says: "drop" sends
    /// half the file and closes, "ok" the whole file, a number that status. Its port, and how
    /// many requests it had, read from its folder.
    private func server(_ answers: [String], file: Data, in folder: URL) throws -> (port: Int, process: Process) {
        try file.write(to: folder.appending(path: "file"))
        let script = """
            import http.server, socketserver, sys, os
            folder = sys.argv[1]; answers = sys.argv[2].split(",")
            data = open(os.path.join(folder, "file"), "rb").read()
            count = [0]
            class Handler(http.server.BaseHTTPRequestHandler):
                def log_message(self, *a): pass
                def do_GET(self):
                    answer = answers[min(count[0], len(answers) - 1)]; count[0] += 1
                    open(os.path.join(folder, "requests"), "w").write(str(count[0]))
                    if answer.isdigit():
                        self.send_response(int(answer)); self.send_header("Content-Length", "0"); self.end_headers(); return
                    self.send_response(200); self.send_header("Content-Length", str(len(data))); self.end_headers()
                    if answer == "drop":
                        self.wfile.write(data[: len(data) // 2]); self.wfile.flush(); self.connection.close(); return
                    self.wfile.write(data)
            server = socketserver.TCPServer(("127.0.0.1", 0), Handler)
            open(os.path.join(folder, "port"), "w").write(str(server.server_address[1]))
            server.serve_forever()
            """
        let process = Process()
        process.executableURL = URL(filePath: "/usr/bin/python3")
        process.arguments = ["-I", "-c", script, folder.path, answers.joined(separator: ",")]
        try process.run()
        let portFile = folder.appending(path: "port")
        for _ in 0..<100 where !FileManager.default.fileExists(atPath: portFile.path) { usleep(50_000) }
        let port = Int(try String(contentsOf: portFile, encoding: .utf8)) ?? 0
        return (port, process)
    }

    private func release(port: Int, file: Data) -> EngineRelease {
        let integrity = "sha512-" + Data(SHA512.hash(data: file)).base64EncodedString()
        return EngineRelease(version: "test", tarball: URL(string: "http://127.0.0.1:\(port)/engine.tgz")!, integrity: integrity, teamIdentifier: "")
    }

    private func folder() throws -> URL {
        let folder = FileManager.default.temporaryDirectory.appending(path: "opencodekit-download-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        return folder
    }

    @Test func aDroppedDownloadIsTriedAgain() async throws {
        let folder = try folder()
        defer { try? FileManager.default.removeItem(at: folder) }
        let file = Data((0..<2_000_000).map { UInt8($0 % 251) })
        let (port, process) = try server(["drop", "ok"], file: file, in: folder)
        defer { process.terminate() }
        let download = try await EngineInstaller.download(release(port: port, file: file)) { _ in }
        defer { try? FileManager.default.removeItem(at: download) }
        #expect(try Data(contentsOf: download) == file)
        #expect(try String(contentsOf: folder.appending(path: "requests"), encoding: .utf8) == "2")
    }

    @Test func aRefusedDownloadSaysWithWhat() async throws {
        let folder = try folder()
        defer { try? FileManager.default.removeItem(at: folder) }
        let file = Data("engine".utf8)
        let (port, process) = try server(["403"], file: file, in: folder)
        defer { process.terminate() }
        do {
            _ = try await EngineInstaller.download(release(port: port, file: file)) { _ in }
            Issue.record("it downloaded")
        } catch {
            #expect(EngineInstallError.kind(of: error) == "http_403")
            #expect(error.localizedDescription.contains("HTTP 403"))
        }
    }

    /// A download that isn't the engine's archive says it couldn't be unpacked, with what tar
    /// said, and leaves nothing installed.
    @Test func aDownloadThatIsntAnArchiveSaysWhy() async throws {
        let folder = try folder()
        defer { try? FileManager.default.removeItem(at: folder) }
        let file = Data("not an archive".utf8)
        let (port, process) = try server(["ok"], file: file, in: folder)
        defer { process.terminate() }
        let installer = EngineInstaller(root: folder.appending(path: "engine"), release: release(port: port, file: file))
        do {
            _ = try await installer.install()
            Issue.record("it installed")
        } catch let error as EngineInstallError {
            guard case .extractionFailed(let output) = error else { Issue.record("\(error)"); return }
            #expect(!output.isEmpty, "with what tar said")
        }
        #expect(installer.installed() == nil)
    }

    @Test func kindsOfTrouble() {
        #expect(EngineInstallError.kind(of: URLError(.notConnectedToInternet)) == "offline")
        #expect(EngineInstallError.kind(of: URLError(.cannotFindHost)) == "dns")
        #expect(EngineInstallError.kind(of: URLError(.serverCertificateUntrusted)) == "tls")
        #expect(EngineInstallError.kind(of: EngineInstallError.integrityMismatch) == "checksum")
        #expect(EngineInstallError.kind(of: CocoaError(.fileWriteOutOfSpace)) == "disk")
        #expect(EngineInstallError.kind(of: ServerProcessError.timedOut) == "other")
    }
}
