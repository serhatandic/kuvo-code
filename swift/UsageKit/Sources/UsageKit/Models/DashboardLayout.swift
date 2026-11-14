import Foundation

/// One widget placed on the dashboard. Stable `id` so reordering/animation is identity-based;
/// `descriptorID` links back to the registry for its data + render kind.
struct PlacedWidget: Identifiable, Hashable, Codable {
    var id: UUID
    let descriptorID: String

    init(id: UUID = UUID(), descriptorID: String) {
        self.id = id
        self.descriptorID = descriptorID
    }
}
