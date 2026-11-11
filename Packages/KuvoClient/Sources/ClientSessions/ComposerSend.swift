import Foundation
import OpenCodeKit

/// What a composer's Send does with what's written, the same in both apps. With no model chosen
/// (the model chip says "Choose a Model"), nothing goes: Send is off and Return opens the model
/// picker instead, everything written kept in the field, as Cursor's, Codex's and Claude's
/// composers never send without a model. What needs no model still goes: a "!" command, which runs
/// in the project's folder, and showing, pausing or taking away a goal.
public enum ComposerSend: Equatable, Sendable {
    /// It goes.
    case send
    /// No model to send it with: Send is off, and Return opens the model picker.
    case chooseModel
    /// Nothing to send now (an empty field, its computer away, a side question still being
    /// answered): Send is off, and Return does nothing.
    case wait

    /// `ready`: what's written could go, the model aside (words, a file or an answer, its computer
    /// in reach). `hasModel`: the model chip names a model (the one picked, or the default for a
    /// conversation with none of its own), or there's no chip to choose with. `runsShell`: a "!"
    /// command runs in the shell here (with a coding agent's conversation on the phone, it's words).
    public init(ready: Bool, text: String, hasModel: Bool, runsShell: Bool = true) {
        if !ready { self = .wait }
        else if hasModel || !Self.needsModel(text, runsShell: runsShell) { self = .send }
        else { self = .chooseModel }
    }

    /// Send can be pressed.
    public var sends: Bool { self == .send }

    /// Whether what's written needs a model to go: everything but a "!" command, and showing,
    /// pausing or taking away a goal (resuming one starts its next turn on the model).
    public static func needsModel(_ text: String, runsShell: Bool = true) -> Bool {
        if runsShell, text.hasPrefix("!"), !text.dropFirst().trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return false }
        guard let goal = GoalCommand(text) else { return true }
        return goal.needsModel || goal == .resume
    }
}
