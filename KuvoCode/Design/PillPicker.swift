import ClientDesign
import SwiftUI

/// A choice of a few, drawn as the title bar's tabs are: a glass track, the one chosen a raised
/// pill that slides to whichever you pick.
struct PillPicker<Value: Hashable>: View {
    struct Option: Identifiable {
        let value: Value
        let title: String
        var symbol: String?
        var id: Value { value }
    }

    let options: [Option]
    @Binding var selection: Value
    @Namespace private var pill

    var body: some View {
        HStack(spacing: 0) {
            ForEach(options) { option in
                let isOn = option.value == selection
                Button {
                    withAnimation(.ui) { selection = option.value }
                } label: {
                    HStack(spacing: 5) {
                        if let symbol = option.symbol {
                            Image(systemName: symbol)
                                .font(.system(size: 11))
                        }
                        Text(option.title)
                            .lineLimit(1)
                    }
                    .font(.system(size: 12.5, weight: isOn ? .semibold : .regular))
                    .foregroundStyle(isOn ? .primary : .secondary)
                    .padding(.horizontal, 12)
                    .frame(height: 26)
                    .contentShape(.capsule)
                    .hoverHighlight(in: Capsule(), mutesInk: true)
                }
                .buttonStyle(.plain)
                .clickablePointer()
                .background {
                    if isOn {
                        ActivePill()
                            .matchedGeometryEffect(id: "pill", in: pill)
                    }
                }
            }
        }
        .padding(3)
        .glassEffect(.regular, in: .capsule)
        .fixedSize()
    }
}
