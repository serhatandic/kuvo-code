import ClientDesign
import ClientSessions
import OpenCodeKit
import SwiftUI

/// The one time a goal's card asks which model does the work, in Execution settings: while the
/// box picked Power itself and hasn't asked, its pick and why, and the model picker. A model picked
/// there is Power on that box from then on, for every session and goal, and the row goes.
struct GoalModelRow: View {
    let box: String
    @Environment(AppModel.self) private var app
    @State private var roles: ModelRoles?
    @State private var failure: String?
    @State private var isSetting = false

    var body: some View {
        if let roles, roles.asksOnGoalCard, let power = roles.power {
            VStack(alignment: .leading, spacing: 0) {
                Divider().padding(.leading, GoalCardMetrics.markWidth + 12)
                GoalSettingRow(symbol: "cpu", title: "Model", subtitle: failure ?? power.why ?? "Kuvo’s pick for the work here") {
                    if isSetting { Spinner(size: 9) }
                    ModelChip(selection: power.model, onSelect: set, opensBelow: true, scope: .at(nil), offersAuto: false) { model, variant in
                        ModelChipLabel(model: model.map { named($0, power) }, variant: variant)
                    }
                    .disabled(isSetting)
                }
            }
            .transition(.opacity)
        } else {
            Color.clear.frame(height: 0)
                .task(id: box) { await read() }
        }
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
                withAnimation(.ui) { roles = answered }
            } catch {
                failure = (error as? BoxRefusal)?.message ?? error.localizedDescription
            }
        }
    }
}
