import Foundation
import Testing
@testable import KuvoCode

/// Settings › Machines › Add a Machine: the hosts it offers from your SSH config, and what it
/// takes as a machine's address.
@Suite struct AddMachineTests {
    let home: URL

    init() throws {
        TestEnvironment.prepare()
        home = AppInfo.testRoot.appending(path: "Home/\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: home.appending(path: ".ssh/config.d"), withIntermediateDirectories: true)
    }

    private func write(_ path: String, _ text: String) throws {
        try Data(text.utf8).write(to: home.appending(path: path))
    }

    @Test func offersTheHostsYourSSHConfigNames() throws {
        try write(".ssh/config", """
        # My machines
        Host box # the home server
            HostName 192.168.1.20
            User me
        Host vps staging-*  web
        Host=lab
        #Host old-one
        Match host *.internal
            User admin
          Host indented
        Host *
            ServerAliveInterval 30
        Include config.d/*
        Include ~/.ssh/extra
        """)
        try write(".ssh/config.d/work", "Host work-db\nHost box\n")
        try write(".ssh/extra", "Host extra-one\n")
        // No patterns, no comments, each once, in the order they come.
        #expect(SSHConfig.hosts(home: home) == ["box", "vps", "web", "lab", "indented", "work-db", "extra-one"])
    }

    @Test func noConfigOffersNothing() throws {
        #expect(SSHConfig.hosts(home: home).isEmpty)
    }

    /// Includes that include each other don't go round forever.
    @Test func includesThatLoopEnd() throws {
        try write(".ssh/config", "Host a\nInclude config.d/b\n")
        try write(".ssh/config.d/b", "Host b\nInclude config\n")
        #expect(SSHConfig.hosts(home: home) == ["a", "b"])
    }

    @Test(arguments: ["box", "me@box", "192.168.1.20", "me@vps.example.com", "work-db"])
    func takesAHostOrUserAtHost(destination: String) {
        #expect(MachineForm.problem(with: destination) == nil)
    }

    /// What ssh would read as something else: an option, a port, a path, an IPv6 address, spaces.
    @Test(arguments: ["-oProxyCommand=sh", "box:2222", "ssh://box", "fe80::1", "my box", "box/"])
    func refusesWhatIsntOne(destination: String) {
        #expect(MachineForm.problem(with: destination) != nil)
    }
}
