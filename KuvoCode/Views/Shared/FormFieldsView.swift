import ClientDesign
import OpenCodeKit
import SwiftUI

/// Renders the engine's form schema natively. The same schema drives the agent's
/// questions, MCP prompts, and the details a sign-in method needs (an enterprise
/// URL, a cloud project), so new providers need no new UI.
struct FormFieldsView: View {
    enum Style { case question, settings }

    let fields: [FormField]
    @Binding var answers: FormAnswer
    var style = Style.settings

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            ForEach(visibleFields) { field in
                FieldView(field: field, value: binding(for: field), style: style)
            }
        }
    }

    private var visibleFields: [FormField] {
        fields.filter { !$0.isHidden && $0.isActive(given: answers) }
    }

    private func binding(for field: FormField) -> Binding<FormValue?> {
        Binding(get: { answers[field.key] }, set: { answers[field.key] = $0 })
    }

    /// The answers to send: only fields that apply, hidden ones at their defaults.
    static func payload(_ fields: [FormField], _ answers: FormAnswer) -> FormAnswer {
        var result: FormAnswer = [:]
        for field in fields where field.isActive(given: answers) {
            if let value = answers[field.key] ?? (field.isHidden ? field.defaultValue : nil) {
                if case .string(let text) = value, text.isEmpty, !field.isRequired { continue }
                result[field.key] = value
            }
        }
        return result
    }

    static func defaults(for fields: [FormField]) -> FormAnswer {
        var result: FormAnswer = [:]
        for field in fields { result[field.key] = field.defaultValue }
        return result
    }

    static func isComplete(_ fields: [FormField], _ answers: FormAnswer) -> Bool {
        fields.filter { $0.isRequired && !$0.isHidden && $0.isActive(given: answers) }.allSatisfy { field in
            switch answers[field.key] {
            case .string(let text): !text.trimmingCharacters(in: .whitespaces).isEmpty
            case .list(let items): !items.isEmpty
            case .bool(let value): if case .external = field.kind { value } else { true }
            case .number: true
            case nil: false
            }
        }
    }
}

private struct FieldView: View {
    let field: FormField
    @Binding var value: FormValue?
    let style: FormFieldsView.Style
    @State private var custom = ""
    @FocusState private var isFocused: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if let title = field.title {
                Text(title)
                    .font(style == .question ? .body.weight(.semibold) : .callout.weight(.medium))
            }
            if let description = field.description {
                Text(description)
                    .font(.callout)
                    .foregroundStyle(.secondary)
            }
            control
        }
    }

    /// What VoiceOver calls its field: its title shows above it, not as its label.
    private var name: String { field.title ?? field.key }

    @ViewBuilder private var control: some View {
        switch field.kind {
        case .string(let options, let allowsCustom, let placeholder, _, let format, _):
            if let options, !options.isEmpty {
                OptionList(options: options, selection: [stringValue].compactMap { $0 }, multiple: false) { picked in
                    value = .string(picked)
                    custom = ""
                }
                if allowsCustom {
                    TextField("Something else…", text: $custom)
                        .wellField(isFocused: isFocused)
                        .focused($isFocused)
                        .onChange(of: custom) { old, text in
                            if !text.isEmpty { value = .string(text) }
                            // Cleared: no answer, rather than its last letter (a choice picked
                            // since, which empties this, stays).
                            else if stringValue == old { value = nil }
                        }
                }
            } else if format == "password" {
                SecureField(placeholder ?? "", text: stringBinding)
                    .wellField(isFocused: isFocused)
                    .focused($isFocused)
                    .accessibilityLabel(name)
            } else {
                TextField(placeholder ?? "", text: stringBinding)
                    .wellField(isFocused: isFocused)
                    .focused($isFocused)
                    .accessibilityLabel(name)
            }
        case .number(let isInteger, _, _, _):
            TextField("", value: Binding(
                get: { if case .number(let n) = value { n } else { nil } },
                set: { value = $0.map { .number(isInteger ? $0.rounded() : $0) } }
            ), format: .number)
            .wellField(isFocused: isFocused)
            .focused($isFocused)
            .accessibilityLabel(name)
            .frame(maxWidth: 160)
        case .boolean:
            Toggle(field.title ?? field.key, isOn: Binding(
                get: { if case .bool(let b) = value { b } else { false } },
                set: { value = .bool($0) }
            ))
            .labelsHidden()
        case .multiselect(let options, let allowsCustom, _, _, _):
            OptionList(options: options, selection: listValue, multiple: true) { picked in
                var list = listValue
                if let index = list.firstIndex(of: picked) { list.remove(at: index) } else { list.append(picked) }
                value = .list(list)
            }
            if allowsCustom {
                TextField("Something else…", text: $custom)
                    .wellField(isFocused: isFocused)
                    .focused($isFocused)
                    .onSubmit {
                        guard !custom.isEmpty else { return }
                        value = .list(listValue + [custom])
                        custom = ""
                    }
            }
        case .external(let url):
            HStack {
                if let link = URL(string: url) {
                    Link("Open \(link.host() ?? "page")", destination: link)
                }
                Toggle("Done", isOn: Binding(
                    get: { if case .bool(let b) = value { b } else { false } },
                    set: { value = .bool($0) }
                ))
            }
        case .other:
            EmptyView()
        }
    }

    private var stringValue: String? {
        if case .string(let s) = value { s } else { nil }
    }

    private var listValue: [String] {
        if case .list(let l) = value { l } else { [] }
    }

    private var stringBinding: Binding<String> {
        Binding(get: { stringValue ?? "" }, set: { value = .string($0) })
    }
}

/// Choices as tappable rows, with their descriptions.
private struct OptionList: View {
    let options: [FormField.Option]
    let selection: [String]
    let multiple: Bool
    let pick: (String) -> Void

    var body: some View {
        VStack(spacing: 6) {
            ForEach(options) { option in
                let isSelected = selection.contains(option.value)
                Button {
                    withAnimation(.ui) { pick(option.value) }
                } label: {
                    HStack(alignment: .firstTextBaseline, spacing: 10) {
                        Image(systemName: multiple ? (isSelected ? "checkmark.square.fill" : "square") : (isSelected ? "largecircle.fill.circle" : "circle"))
                            .foregroundStyle(isSelected ? AnyShapeStyle(.tint) : AnyShapeStyle(.secondary))
                        VStack(alignment: .leading, spacing: 2) {
                            Text(option.label)
                            if let description = ChoiceText.detail(option.description, label: option.label) {
                                Text(description)
                                    .font(.callout)
                                    .foregroundStyle(.secondary)
                            }
                        }
                        Spacer(minLength: 0)
                    }
                    .padding(.horizontal, 12)
                    .padding(.vertical, 9)
                    // Picked, it's lit as what you pick from a list is everywhere (`pickHighlight`).
                    .accentGlass(RoundedRectangle(cornerRadius: 10), isOn: isSelected)
                }
                // An option lights up under the pointer, like the button it is.
                .buttonStyle(FilledButtonStyle(shape: .rect(cornerRadius: 10), rest: isSelected ? 0 : 0.045))
            }
        }
    }
}

/// What a choice says under its label: its description, unless that only repeats the label
/// ("Red" under Red), as models often write.
enum ChoiceText {
    static func detail(_ description: String?, label: String) -> String? {
        guard let description = description?.trimmingCharacters(in: .whitespacesAndNewlines), !description.isEmpty,
              description.compare(label.trimmingCharacters(in: .whitespacesAndNewlines), options: .caseInsensitive) != .orderedSame
        else { return nil }
        return description
    }
}
