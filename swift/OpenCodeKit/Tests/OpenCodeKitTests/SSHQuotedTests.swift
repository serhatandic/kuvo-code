import Foundation
import Testing
import OpenCodeKit

/// Names sent in a command to a machine reach it as written, never as more of the command.
@Suite struct SSHQuotedTests {
    /// Whatever a name holds, the shell on the other side gets it as one word, as written.
    @Test(arguments: ["plain", "two words", "it's", "a'; rm -rf ~; echo '", "$(whoami)", "`id`", "back\\slash", "new\nline", ""])
    func namesReachTheShellAsWritten(name: String) throws {
        let process = Process()
        process.executableURL = URL(filePath: "/bin/sh")
        process.arguments = ["-c", "printf %s " + SSHConnection.quoted(name)]
        let output = Pipe()
        process.standardOutput = output
        try process.run()
        let data = output.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        #expect(String(decoding: data, as: UTF8.self) == name)
    }
}
