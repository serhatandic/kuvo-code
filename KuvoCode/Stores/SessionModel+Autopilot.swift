import ClientSessions
import Foundation
import OpenCodeKit

/// A conversation's Autopilot as its box shows it (`GET kuvo/sessions/<id>/autopilot`, PROTOCOL.md
/// "Autopilot"): whether it's on, and the calls it made where a question would have waited.
/// Mode says what may run without asking; Autopilot, what may be decided without asking.
struct AutopilotShown: Decodable, Equatable {
    struct Call: Decodable, Equatable, Identifiable {
        struct Yours: Decodable, Equatable {
            var choice: String
            var at: Double
        }
        /// The question's form.
        var id: String
        var text: String
        var choice: String
        var why: String?
        var options: [String]?
        var multiple: Bool?
        /// The session that asked, where it's a subagent's.
        var session: String?
        /// The tool call that asked it: the step it shows at.
        var call: String?
        var at: Double
        /// Your choice since.
        var yours: Yours?

        /// One of a goal's, as its card shows it.
        init(goal call: GoalPlan.Decided, changeable: Bool) {
            id = call.id
            text = call.text
            choice = call.choice
            why = call.why
            options = changeable ? call.options : nil
            multiple = call.multiple
            session = call.session
            at = call.at
            yours = call.yours.map { Yours(choice: $0.choice, at: $0.at) }
        }

        /// What it goes with now: yours, once you've picked.
        var current: String { yours?.choice ?? choice }
        /// You picked another than it went with.
        var changed: Bool { yours.map { $0.choice != choice } ?? false }

        /// Takes several (`options`), joined in `choice`.
        var isMultiple: Bool { multiple == true }
        /// Whether `option` is what it goes with now.
        func isChosen(_ option: String) -> Bool {
            isMultiple ? ", \(current), ".contains(", \(option), ") : option == current
        }
        /// What it goes with once `option` is picked: where it takes several, that one added or
        /// taken out (nil where none would be left).
        func picking(_ option: String) -> String? {
            guard isMultiple, let options else { return option }
            let chosen = options.filter { $0 == option ? !isChosen($0) : isChosen($0) }
            return chosen.isEmpty ? nil : chosen.joined(separator: ", ")
        }
    }
    var autopilot: Bool
    var decided: [Call]

    static let symbol = "airplane"
    /// Its entry in a conversation's instructions, as its box sets it (`AUTOPILOT_ENTRY`).
    static let instructionKey = "kuvo.autopilot"
    static let detail = ApprovalWords.autopilot

    /// Whether a conversation is kept on Autopilot (`metadata.kuvo.autopilot`), until its box says.
    static func isOn(_ session: Session) -> Bool {
        session.metadata?["kuvo"]?["autopilot"]?.bool == true
    }

    /// The call it made where `call` asked, if it made one.
    func decided(at call: String) -> Call? {
        decided.last { $0.call == call }
    }

    /// The calls it made, by the tool call that asked (a form may ask several).
    var byCall: [String: [Call]] {
        Dictionary(grouping: decided.filter { $0.call != nil }) { $0.call ?? "" }
    }

    /// Where its calls show in a conversation's rows: most at the step that asked (`byCall`); a subagent's at the subagent's own row or step, with what it asked; and what has no
    /// step here, under the rows.
    struct Places: Equatable {
        var bySubagent: [String: [Call]] = [:]
        var alone: [Call] = []
    }

    /// `steps`, the tool calls in the rows; `subagents`, the sessions of the subagents among them;
    /// `whole`, the rows go back to its start, so one not among them won't come in with earlier
    /// ones; `subagent`, the conversation shown where it's a subagent, which shows only its own.
    func places(steps: Set<String>, subagents: Set<String>, whole: Bool, subagent: String? = nil) -> Places {
        var places = Places()
        for call in decided {
            if let asked = call.call, steps.contains(asked) { continue }
            if subagent == nil, let session = call.session, subagents.contains(session) {
                places.bySubagent[session, default: []].append(call)
            } else if subagent == nil || call.session == subagent, whole || (call.call == nil && call.session == nil) {
                places.alone.append(call)
            }
        }
        return places
    }
}

/// Autopilot in a conversation's Mode menu: on or off, or why it isn't to be had there.
struct AutopilotChoice: Equatable {
    var on: Bool
    /// Its computer's box is from before Autopilot.
    var unavailable: String?
}

extension SessionModel {
    private var autopilotRoute: String { "kuvo/sessions/\(id)/autopilot" }

    /// On Autopilot, as its box shows it (as it's kept with it until read).
    var isAutopilot: Bool { autopilotShown?.autopilot ?? AutopilotShown.isOn(session) }

    /// As the Mode menu offers it: nil until its box is known.
    var autopilotChoice: AutopilotChoice? {
        autopilotShown.map { AutopilotChoice(on: $0.autopilot) }
    }

    /// Reads its Autopilot and the calls it made, as its box has them. Not while a switch is on its
    /// way: what it brings may be from before the box took it.
    func readAutopilot() async {
        guard autopilotPending == 0, let box = box() else { return }
        let asked = autopilotChanges
        guard let shown = try? await box.value(AutopilotShown.self, "GET", autopilotRoute) else { return }
        guard asked == autopilotChanges, autopilotPending == 0 else { return }
        if autopilotShown != shown { autopilotShown = shown }
    }

    /// Turns Autopilot on or off here, on its box: shown at once, and back as it was if its box
    /// doesn't take it.
    func setAutopilot(_ on: Bool) {
        guard on != isAutopilot else { return }
        _ = sendAutopilot(on)
    }

    /// `setAutopilot`, done once its box has it: whether it's set so now.
    @discardableResult
    func switchAutopilot(_ on: Bool) async -> Bool {
        guard on != isAutopilot else { return true }
        return await sendAutopilot(on)?.value ?? false
    }

    /// Shows `on` at once and sends it to its box: whether its box took it. Nil where it can't be
    /// sent.
    private func sendAutopilot(_ on: Bool) -> Task<Bool, Never>? {
        guard canReach, let box = box() else { return nil }
        autopilotChanges += 1
        autopilotPending += 1
        let pick = autopilotChanges
        let before = autopilotShown
        autopilotShown = AutopilotShown(autopilot: on, decided: autopilotShown?.decided ?? [])
        let route = autopilotRoute
        return Task {
            defer { autopilotPending -= 1 }
            do {
                let shown = try await box.value(AutopilotShown.self, "PUT", route, body: ["autopilot": on])
                if pick == autopilotChanges { autopilotShown = shown }
                return true
            } catch {
                if pick == autopilotChanges {
                    autopilotShown = before
                    failApproval(error)
                }
                return false
            }
        }
    }

    /// Your choice on a call it made: the same confirms it; another tells its agent to go that way.
    func choose(_ choice: String, on call: AutopilotShown.Call) {
        guard canReach, let box = box(), choice != call.current else { return }
        Task {
            do {
                autopilotShown = try await box.value(AutopilotShown.self, "POST", autopilotRoute, body: ["decided": call.id, "choice": choice])
            } catch {
                failApproval(error)
            }
        }
    }
}
