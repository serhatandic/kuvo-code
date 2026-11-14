import AppKit
import SwiftUI

/// A date and time to type or step through, without a field's box: for a row in a well, which is
/// the field already. Arrow keys and typing work as in any of macOS's date fields.
struct PlainDatePicker: NSViewRepresentable {
    @Binding var date: Date
    /// The earliest it takes.
    var from: Date?

    func makeNSView(context: Context) -> NSDatePicker {
        let picker = NSDatePicker()
        picker.datePickerStyle = .textField
        picker.datePickerElements = [.yearMonthDay, .hourMinute]
        picker.isBezeled = false
        picker.isBordered = false
        picker.drawsBackground = false
        picker.font = .systemFont(ofSize: NSFont.systemFontSize)
        picker.focusRingType = .none
        picker.target = context.coordinator
        picker.action = #selector(Coordinator.changed(_:))
        picker.setContentHuggingPriority(.required, for: .horizontal)
        return picker
    }

    func updateNSView(_ picker: NSDatePicker, context: Context) {
        context.coordinator.parent = self
        picker.minDate = from
        if picker.dateValue != date { picker.dateValue = date }
    }

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    final class Coordinator: NSObject {
        var parent: PlainDatePicker

        init(_ parent: PlainDatePicker) { self.parent = parent }

        @objc func changed(_ picker: NSDatePicker) {
            parent.date = picker.dateValue
        }
    }
}
