#if DEBUG
import AppKit
import OpenCodeKit
import SwiftUI

/// Move to Computer, for a look without a second computer: `KUVO_DEMO_MOVES` shows the first bot,
/// group chat and chat on their way (copying, getting ready, finishing) and gives every bot two
/// places (lab, and a Mac mini that needs a newer Kuvo Code); `KUVO_DEMO_MOVE_MENU=<bot name>`
/// builds that bot's Move to Computer list as its menu does, before and after its box says where it
/// can go, and prints what the menu shows each time.
@MainActor
enum DemoMoves {
    private static var ran = false

    static func showIfAsked(_ environment: [String: String], app: AppModel) {
        guard !ran, app.workspace.isLoaded else { return }
        let menuFor = environment["KUVO_DEMO_MOVE_MENU"]
        guard environment["KUVO_DEMO_MOVES"] != nil || menuFor != nil else { return }
        ran = true
        Task {
            _ = await DemoWait.until("the bots (KUVO_DEMO_MOVES)") { !app.bots.list.isEmpty }
            let places = [
                Moves.Place(key: "lab-key", name: "lab", kind: "machine", ok: true),
                Moves.Place(key: "mini-key", name: "Mac mini", kind: "mac", ok: false, why: "Mac mini needs a newer Kuvo Code before things can move to or from it.", note: "Needs a newer Kuvo Code"),
            ]
            if let name = menuFor, let bot = app.bots.list.first(where: { $0.name == name }) {
                // Made as the menu makes it when it opens, before and after.
                let shown = { () -> String in
                    let menu = HeldRow.menu(MoveToComputerItems(thing: .bot(bot), app: app).rows)
                    return menu.items.map { "\($0.title)\($0.subtitle.map { " / " + $0 } ?? "")\($0.isEnabled ? "" : " (dimmed)")" }.joined(separator: "; ")
                }
                print("KUVO_DEMO_MOVE_MENU before its box said: \(shown())")
                fflush(stdout)
                app.moves.showDemo(places: [bot.id: (bot.machine, places)])
                await DemoWait.pause(.windowSettles)
                print("KUVO_DEMO_MOVE_MENU after: \(shown())")
                fflush(stdout)
            }
            guard environment["KUVO_DEMO_MOVES"] != nil else { return }
            var going: [String: Moves.Going] = [:]
            // KUVO_DEMO_MOVES=waiting: each coming to this Mac, waiting for the machine it leaves.
            let waiting = environment["KUVO_DEMO_MOVES"] == "waiting" ? "devbox" : nil
            if let bot = app.bots.list.first { going[bot.id] = Moves.Going(place: waiting == nil ? "lab" : "this Mac", stage: "copying", sent: 12_400_000, size: 30_000_000, waitingFor: waiting) }
            if let group = app.chats.list.first { going[group.id] = Moves.Going(place: waiting == nil ? "lab" : "this Mac", waitingFor: waiting) }
            if let chat = app.workspace.sessions.first(where: { $0.parentID == nil && Workspace.isChat($0) }) {
                going[chat.id] = Moves.Going(place: waiting == nil ? "Studio Mac" : "this Mac", stage: waiting == nil ? "switching" : "copying", waitingFor: waiting)
            }
            app.moves.showDemo(going: going, places: Dictionary(uniqueKeysWithValues: app.bots.list.map { ($0.id, ($0.machine, places)) }))
            print("KUVO_DEMO_MOVES: \(going.count) on their way")
            fflush(stdout)
        }
    }
}
#endif
