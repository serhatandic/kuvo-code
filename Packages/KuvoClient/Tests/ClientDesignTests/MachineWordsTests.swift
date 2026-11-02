import ClientDesign
import Testing

/// What both apps say of a machine one of your Macs connects and removes: the step its first
/// connection is on, and whom Uninstall would stop it for.
struct MachineWordsTests {
    @Test func aFirstConnectionsStepInARow() {
        #expect(MachineWords.step("copying") == "Copying the engine")
        #expect(MachineWords.step("downloading") == "Downloading the engine")
        #expect(MachineWords.step("reading") == "Reading its sessions")
        #expect(MachineWords.step("something-newer") == nil)
    }

    /// Others use it: named, and Uninstall says it's for every Mac; Remove stays off this one only.
    @Test func removeNamesWhoElseUsesItBeforeUninstallStopsItForThem() {
        let both = MachineWords.removal(of: "devbox", home: nil, otherMacs: ["Studio"], phones: 2, phonesKeepIt: true, device: "this Mac")
        #expect(both.message == "Remove takes it off this Mac only. Studio and your phones also use devbox: Uninstall stops it for everyone and deletes its sign-ins and keys.")
        #expect(both.uninstall == "Uninstall for Every Mac")
        let mac = MachineWords.removal(of: "devbox", home: nil, otherMacs: ["Studio"], phones: 0, phonesKeepIt: false, device: "this Mac")
        #expect(mac.message == "Remove takes it off this Mac only. Studio also uses devbox: Uninstall stops it for everyone and deletes its sign-ins and keys.")
        let phone = MachineWords.removal(of: "devbox", home: nil, otherMacs: [], phones: 1, phonesKeepIt: true, device: "MacBook Air")
        #expect(phone.message == "Remove takes it off MacBook Air only. Your phone also uses devbox: Uninstall stops it for everyone and deletes its sign-ins and keys.")
        #expect(phone.uninstall == "Uninstall from devbox", "no other Mac: it's this one's to uninstall")
    }

    @Test func oneAnotherMacRunsIsUninstalledOnlyFromThere() {
        let words = MachineWords.removal(of: "devbox", home: "Studio", otherMacs: ["Studio"], phones: 0, phonesKeepIt: true, device: "this Mac")
        #expect(words.uninstall == nil)
        #expect(words.message == "Studio runs devbox, so it can be uninstalled only from there. Remove takes it off this Mac; it keeps running, with its sessions, bots, sign-ins and keys.")
    }

    @Test func noOneElseItSaysWhatEachDoes() {
        let words = MachineWords.removal(of: "devbox", home: nil, otherMacs: [], phones: 0, phonesKeepIt: true, device: "this Mac")
        #expect(words.uninstall == "Uninstall from devbox")
        #expect(words.message == "Remove takes it off this Mac; it keeps running, with its sessions, bots, sign-ins and keys, and your phones keep it. Uninstall also stops it there and deletes its sign-ins and keys.")
    }

    /// Who else uses it not read yet (it hasn't connected since the app opened): Uninstall never
    /// sounds as if it's this Mac's alone.
    @Test func notKnownWhoElseUsesItUninstallSaysItsForAnyone() {
        let words = MachineWords.removal(of: "devbox", home: nil, otherMacs: nil, phones: 0, phonesKeepIt: true, device: "this Mac")
        #expect(words.uninstall == "Uninstall from devbox")
        #expect(words.message.contains("for any other Mac or phone that uses it"))
        #expect(words.message.contains("your phones keep it"), "a paired phone keeps it, known or not")
        #expect(!MachineWords.removal(of: "devbox", home: nil, otherMacs: nil, phones: 0, phonesKeepIt: false, device: "this Mac").message.contains("phones keep it"))
    }

    @Test func aRowWhileTheEngineComesSaysHowFar() {
        #expect(MachineWords.installing(step: "copying", sent: 41_000_000, total: 98_000_000) == "Copying the engine · 41 of 98 MB")
        #expect(MachineWords.installing(step: "downloading", fraction: 0.34) == "Downloading the engine · 34%")
        #expect(MachineWords.installing(step: "copying") == "Copying the engine…")
        #expect(MachineWords.installing(step: "starting") == nil)
    }
}
