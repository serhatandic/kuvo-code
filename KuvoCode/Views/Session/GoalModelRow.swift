import ClientDesign
import ClientSessions
import OpenCodeKit
import SwiftUI

/// The one time a goal's card asks which model does the work, in Execution settings: while the
/// box picked Power itself and hasn't asked, its pick and why, and the model picker. A model picked
/// there is Power on that box from then on, for every session and goal; the row shows it until
/// the card goes.
struct GoalModelRow: View {
    let box: String
    /// While it shows the box's pick and you haven't picked: Start Goal tells the box you were asked.
    @Binding var asks: Bool
    @Environment(AppModel.self) private var app
    @State private var roles: ModelRoles?
    @State private var failure: String?
    @State private var isSetting = false
    /// Picked here: the row stays, with the pick, until the card goes.
    @State private var picked = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            // What reads the roles, whichever box the card is on.
            Color.clear.frame(height: 0)
            if let roles, let power = roles.power, roles.asksOnGoalCard || picked {
                Divider().padding(.leading, GoalCardMetrics.markWidth + 12)
                GoalSettingRow(symbol: "cpu", title: "Model", subtitle: failure ?? (picked ? "For all work on \(computer) from now on" : power.why ?? "Kuvo’s pick for the work here")) {
                    if isSetting { Spinner(size: 9) }
                    // A filled pop-up like the rows' beside it, opening the composer's picker.
                    ModelChip(selection: power.model, onSelect: set, opensBelow: true, scope: .at(nil), offersAuto: false, popUp: true) { model, variant in
                        HStack(spacing: 5) {
                            if power.entries.isEmpty {
                                Text("None")
                            } else {
                                Text(model.map { named($0, power) }?.name ?? "Choose a Model")
                                    .lineLimit(1)
                                if let variant {
                                    Text(EffortLevel.title(variant))
                                        .foregroundStyle(.secondary)
                                }
                            }
                            // Where a pop-up menu draws its own.
                            Image(systemName: "chevron.up.chevron.down")
                                .font(.system(size: 11, weight: .semibold))
                                .padding(.leading, 13)
                                .padding(.trailing, -2)
                                .accessibilityHidden(true)
                        }
                    }
                    .disabled(isSetting)
                }
                .transition(.opacity)
            }
        }
        .onChange(of: roles?.asksOnGoalCard == true && !picked, initial: true) { _, now in asks = now }
        .task(id: box) {
            roles = nil
            picked = false
            failure = nil
            await read()
        }
    }

    private var computer: String {
        BoxClient.isThisMac(box) ? "this Mac" : app.machines.engine(box)?.machine.name ?? box
    }

    /// The box's own name for its pick where the models here aren't read yet (the picker shows its id).
    private func named(_ model: Model, _ power: ModelRoles.Role) -> Model {
        guard model.name == model.id, let entry = power.entries.first, entry.modelID == model.id, let name = entry.name else { return model }
        var named = model
        named.name = name
        return named
    }

    private func read() async {
        guard let client = app.goalPlans.client(box) else { return }
        // A box without the roles answers nothing here, and the card asks nothing.
        roles = try? await client.value(ModelRoles.self, "GET", "kuvo/models/roles")
    }

    private func set(_ model: ModelRef) {
        guard let client = app.goalPlans.client(box) else { return }
        isSetting = true
        failure = nil
        Task {
            defer { isSetting = false }
            do {
                let answered = try await client.value(ModelRoles.self, "PUT", "kuvo/models/roles", body: ModelRoles.Set(model))
                withAnimation(.ui) {
                    roles = answered
                    picked = true
                }
            } catch {
                failure = (error as? BoxRefusal)?.message ?? error.localizedDescription
            }
        }
    }
}
