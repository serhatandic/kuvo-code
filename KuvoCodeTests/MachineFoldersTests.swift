import Foundation
import OpenCodeKit
import Testing
@testable import KuvoCode

/// A machine's folders: written `ssh://machine/path` wherever the app keys things by folder, so
/// one never passes for this Mac's; and as URLs and back, whatever the names hold. (Names sent in a
/// command to the machine reach it as written: OpenCodeKit's SSHQuotedTests.)
@Suite struct MachineFoldersTests {
    @Test(arguments: [
        ("my-server", "/home/me/web app"),
        ("me@box", "/srv/Zoë's project"),
        ("lab", "/"),
        ("box", "/tmp/a#b?c%20d"),
    ])
    func aFolderAndBack(machine: String, path: String) {
        let folder = RemoteFolder.folder(path, on: machine)
        #expect(RemoteFolder.isRemote(folder))
        #expect(RemoteFolder.parse(folder)?.machine == machine)
        #expect(RemoteFolder.parse(folder)?.path == path)
        let url = RemoteFolder.url(folder)
        #expect(!url.isFileURL)
        #expect(RemoteFolder.folder(of: url) == folder)
    }

    @Test func thisMacsFoldersStayThisMacs() {
        #expect(!RemoteFolder.isRemote("/Users/me/project"))
        #expect(RemoteFolder.url("/Users/me/project").isFileURL)
        #expect(RemoteFolder.parse("/Users/me/project") == nil)
    }

    /// A path the agent names, on the machine its conversation is on.
    @Test func aPathTheAgentNames() {
        let directory = RemoteFolder.folder("/srv/app", on: "box")
        #expect(RemoteFolder.folder(of: RemoteFolder.fileURL("src/main.go", in: directory)) == RemoteFolder.folder("/srv/app/src/main.go", on: "box"))
        #expect(RemoteFolder.folder(of: RemoteFolder.fileURL("/etc/hosts", in: directory)) == RemoteFolder.folder("/etc/hosts", on: "box"))
        #expect(RemoteFolder.fileURL("src/main.go", in: "/Users/me/app").path == "/Users/me/app/src/main.go")
    }

    /// A sign-in page that sends the browser back to localhost: its port, to forward to the machine.
    @Test func aSignInsReturnPort() throws {
        let url = try #require(URL(string: "https://auth.openai.com/authorize?client_id=x&redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback"))
        #expect(SignInForward.callbackPort(in: url) == 1455)
        #expect(SignInForward.callbackPort(in: URL(string: "https://x.com/a?redirect_uri=https%3A%2F%2Fexample.com%3A8443%2F")!) == nil)
        #expect(SignInForward.callbackPort(in: URL(string: "https://x.com/a?redirect_uri=http%3A%2F%2Flocalhost%3A80%2F")!) == nil)
    }

    /// Why a machine's sign-in can't come back to it, as ssh says: the port taken here, or the
    /// machine out of reach.
    @Test func whyASignInCantComeBack() {
        let taken = SignInForward.problem("bind [127.0.0.1]:1455: Address already in use\nchannel_setup_fwd_listener_tcpip: cannot listen to port: 1455\nCould not request local forwarding.", port: 1455, machine: "box")
        #expect(taken.contains("using port 1455"))
        let away = SignInForward.problem("ssh: Could not resolve hostname box: nodename nor servname provided, or not known", port: 1455, machine: "box")
        #expect(!away.contains("using port"))
        #expect(away.contains("Could not resolve hostname box"))
    }
}
