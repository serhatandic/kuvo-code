// What `StuckServerTests` kills, as a crash would: starts the server it's told to as the app does,
// and waits. Its time limits only matter if the test itself has gone.
#if os(macOS)
import Foundation
import OpenCodeKit

let server = try await ServerProcess.start(executable: URL(filePath: CommandLine.arguments[1]), arguments: [], environment: [:],
                                           directory: URL(filePath: CommandLine.arguments[2]), timeout: .seconds(120))
try await Task.sleep(for: .seconds(120))
withExtendedLifetime(server) {}
#endif
