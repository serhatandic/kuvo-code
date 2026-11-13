import Foundation
import KuvoLink
import OpenCodeKit
import os

nonisolated private let log = Logger(subsystem: "run.kuvo.code", category: "app")

/// The app as the client of this Mac's own box in a home of its own (#333 pieces 3 and 6b; KuvoLink's
/// PROTOCOL.md, "This Mac's app"), once it's attached to it in place. It registers there: where the
/// panel's browser tools answer, for its agents' browser calls (the box's `kuvo-browser.js` sends
/// them there, as the keeper's tools do for the app's box in its folder); where the app is installed,
/// for the box to open it by (its helper, at the box's ask) when an agent needs the browser while
/// it's closed; and where its own host interface answers what only the open app can (a phone's ask
/// of the Mac's own routes, the panel's sign-ins), which the box's helper can't. It offers the box
/// the release it carries, and tells it as it quits. Only with `movesOwnBox` on, and only for a box
/// that says it's a Mac's and takes each (`box.app`, `box.app.host`, `box.update`): the box decides
/// everything else.
extension AppModel {
    struct OwnBoxInfo: Decodable { var kind: String?; var features: [String]? }

    /// Whether the box the app is attached to in place is this Mac's own, moved into a home of its
    /// own (`OwnBoxHome.hasMoved`): the app does for it what it did for the box in its folder (its
    /// link, your phones, your machines' peers), through its routes. A machine's box attached in
    /// place (the Mini's) keeps its own link, which only the Mac that set it up changes.
    var attachedIsOwnBox: Bool { attached != nil && OwnBoxHome.hasMoved }

    /// Registered there (and the release offered), over its server alone, where the box takes the
    /// app's word as its own app's (never through `box route`, which it refuses the app's host from):
    /// waited for while it isn't up (its helper starting it at login, or again after an update),
    /// looking at its record less often as it goes on (`ownBoxServerWaits`, ten minutes in all, then
    /// it stops and says so: the next connection asks again), and tried again a few times should it
    /// not take it then. Held by the update gate where the box couldn't say what it has, it's asked
    /// again as the gate lets it go (`wireStores`), not counted as a try. One at a time (each
    /// connection asks); it ends once the app lets go of the box.
    func registerWithOwnBox() async {
        if let ownBoxRegistering { return await ownBoxRegistering.value }
        let registering = Task { [weak self] in
            guard let self else { return }
            await registering()
        }
        ownBoxRegistering = registering
        await registering.value
        // (Only its own: one let go of meanwhile, and another begun, is that one's.)
        if ownBoxRegistering == registering { ownBoxRegistering = nil }
    }

    /// How long registering waits for this Mac's own box's server between looks at its record: two
    /// seconds, then longer, ten minutes in all. A test's own.
    nonisolated(unsafe) static var ownBoxServerWaits: [Duration] = [2, 2, 4, 8, 16, 30].map(Duration.seconds) + Array(repeating: .seconds(60), count: 9)

    private func registering() async {
        var tries = 0
        var waits = Self.ownBoxServerWaits[...]
        while Self.movesOwnBox, attachedIsOwnBox, !Task.isCancelled {
            if OwnBoxHome.streamsNow {
                switch await registerOnce() {
                case .done, .held: return
                case .again:
                    tries += 1
                    if tries >= 5 { return }
                }
            }
            guard let wait = waits.popFirst() else {
                log.error("This Mac's box's server didn't come up within ten minutes: the app registers there when it next connects")
                return
            }
            try? await Task.sleep(for: wait)
        }
    }

    /// How one registration went: done (registered, or nothing to register with: a box that isn't a
    /// Mac's, or from before it took the app), worth trying again (not answering just then, or not
    /// taking it), or held by the update gate (asked again as it's let go).
    enum OwnBoxRegistration { case done, again, held }

    private func registerOnce() async -> OwnBoxRegistration {
        let client = box(SSHConnection.thisMac)
        let held = { BoxGates.isHeld(SSHConnection.thisMac) }
        guard let info = try? await client.value(OwnBoxInfo.self, "GET", "kuvo/info") else { return held() ? .held : .again }
        guard info.kind == "mac" else { return .done }
        let features = Set(info.features ?? [])
        // The release it carries, at its first quiet moment: the box refuses one that isn't newer.
        if features.contains("box.update") { await offerRelease(to: client) }
        guard features.contains("box.app") else { return .done }
        do {
            _ = try await browserTools.start()
            browserTools.owner = { [weak self] id in await self?.workspace.engineRunOwner(id) }
            browserTools.ready = { [weak self] in await self?.workspace.firstLoad(within: 20) }
        } catch {
            log.error("Browser tools didn't start for this Mac's box: \(error.localizedDescription, privacy: .public)")
            return .done
        }
        guard let tools = browserTools.agentsServer else { return .done }
        var body: [String: Any] = ["tools": ["url": tools.url, "token": tools.token], "bundle": Bundle.main.bundleURL.path(percentEncoded: false)]
        if features.contains("box.app.host"), let host = await hostForOwnBox() { body["host"] = host }
        do {
            let (status, data) = try await client.send("POST", "kuvo/box/app", body: try JSONSerialization.data(withJSONObject: body))
            if status == 200 { return .done }
            if status == 503, BoxRefusal(status: status, data: data).reason == BoxGates.reason { return .held }
            log.error("This Mac's box didn't take the app's registration (\(status))")
        } catch {
            log.error("The app couldn't register with this Mac's box: \(error.localizedDescription, privacy: .public)")
        }
        return .again
    }

    /// A machine's box attached in place (one you set up on this Mac): its server kept running for
    /// the app (`kuvo/box/serve {needed: true}`, `box.serve`: the box's keeper keeps it while it's
    /// wanted; left wanted as the app quits, for the next time it opens), and reached there as Kuvo Code on its computer once the box says
    /// it takes that (`box.serve.mac`, `OwnBoxHome.servesAsMac`), so what follows it streams. A box
    /// from before either is reached through its CLI, a request at a time, as before. Asked each time
    /// it connects (a box updated meanwhile may take it now).
    func askForServer() async {
        guard attached != nil, !attachedIsOwnBox else { return }
        let client = box(SSHConnection.thisMac)
        guard let info = try? await client.value(OwnBoxInfo.self, "GET", "kuvo/info"), attached != nil, !attachedIsOwnBox else { return }
        let features = Set(info.features ?? [])
        OwnBoxHome.servesAsMac.withLock { $0 = features.contains("box.serve.mac") }
        guard features.contains("box.serve") else { return }
        do {
            let (status, _) = try await client.send("POST", "kuvo/box/serve", body: try JSONSerialization.data(withJSONObject: ["needed": true]))
            if status != 200 { log.error("The box here didn't keep its server for the app (\(status))") }
        } catch {
            log.error("The box here couldn't be asked to keep its server: \(error.localizedDescription, privacy: .public)")
        }
    }

    /// The app's host interface, answering this Mac's own box what only the open app can (and
    /// nothing of its keys, which are the box's helper's: `answersOnlyApp`), where it answers. Told
    /// again where, should it start again at a new address.
    private func hostForOwnBox() async -> [String: String]? {
        host.tellsBox = false
        host.answersOnlyApp = true
        host.restarted = { [weak self] in Task { await self?.registerWithOwnBox() } }
        guard (try? await host.start()) != nil else {
            log.error("The app's host interface didn't start for this Mac's box")
            return nil
        }
        return host.address
    }

    /// No longer this Mac's own box's client (let go of it): its host interface stops answering it.
    func leaveOwnBox() {
        ownBoxRegistering?.cancel()
        guard host.answersOnlyApp else { return }
        host.stop()
        host.answersOnlyApp = false
        host.restarted = nil
        host.tellsBox = true
    }

    /// The release this app carries (`MachineEngine.boxRelease`), offered once a launch (`kuvo/box/update
    /// {from}`), whether or not the box has all this app needs (one that hasn't is offered it as it
    /// connects too, by the update gate, and held until it's taken): taken at the box's next quiet
    /// moment, the update way; one that isn't newer than the box, or than what's offered there
    /// already, it refuses (409), which is as it should be.
    private func offerRelease(to client: BoxClient) async {
        guard !offeredOwnBoxRelease, let release = MachineEngine.boxRelease() else { return }
        do {
            let (status, data) = try await client.send("POST", "kuvo/box/update", body: try JSONSerialization.data(withJSONObject: ["from": release.path(percentEncoded: false)]))
            // (Answered: offered, or refused as it should be. Not answering, it's offered next time.)
            offeredOwnBoxRelease = true
            if status != 202 && status != 409 { log.error("This Mac's box didn't take the app's release (\(status)): \(BoxRefusal(status: status, data: data).message, privacy: .public)") }
        } catch {
            log.error("The app couldn't offer this Mac's box its release: \(error.localizedDescription, privacy: .public)")
        }
    }

    /// Tells this Mac's own box, moved, that the app quits (`{tools: null}`, its host going with
    /// them), or quits to install an update (`updating`, so the box doesn't open it over Sparkle):
    /// over its server, as the app goes, waiting a second at most. (Without it, the box finds the app
    /// gone when its tools stop answering.)
    nonisolated static func tellOwnBoxQuitting(updating: Bool) {
        // (Quitting to install an update, said already: quitting adds nothing to it.)
        guard updating || !toldOwnBoxUpdating.withLock({ $0 }) else { return }
        if updating { toldOwnBoxUpdating.withLock { $0 = true } }
        guard AppModel.movesOwnBox, OwnBoxHome.hasMoved, let folder = OwnBoxHome.folder else { return }
        // Noted where the box looks for it too (`run/app-updating`, as the keeper's was), whether or
        // not its server answers now: it never opens the app while Sparkle installs it.
        if updating {
            let note = folder.appending(path: "run/app-updating")
            FileManager.default.createFile(atPath: note.path(percentEncoded: false), contents: Data(String(Int(Date.now.timeIntervalSince1970 * 1000)).utf8), attributes: [.posixPermissions: 0o600])
            try? FileManager.default.setAttributes([.modificationDate: Date.now], ofItemAtPath: note.path(percentEncoded: false))
        }
        guard let served = OwnBoxHome.served(in: folder),
              let body = try? JSONSerialization.data(withJSONObject: updating ? ["updating": true] : ["tools": NSNull()]) else { return }
        var request = URLRequest(url: served.base.appending(path: "kuvo/box/app"), timeoutInterval: 1)
        request.httpMethod = "POST"
        request.httpBody = body
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("app", forHTTPHeaderField: "x-kuvo-from")
        request.setValue("Basic " + Data("opencode:\(served.password)".utf8).base64EncodedString(), forHTTPHeaderField: "Authorization")
        let done = DispatchSemaphore(value: 0)
        PhoneLink.boxSession.dataTask(with: request) { _, _, _ in done.signal() }.resume()
        _ = done.wait(timeout: .now() + 1)
    }

    /// The app said it quits to install an update (`tellOwnBoxQuitting`).
    nonisolated static let toldOwnBoxUpdating = OSAllocatedUnfairLock(initialState: false)
}
