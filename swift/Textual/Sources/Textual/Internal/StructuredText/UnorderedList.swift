import SwiftUI

extension StructuredText {
  struct UnorderedList: View {
    @Environment(\.listItemSpacing) private var listItemSpacing
    @Environment(\.textEnvironment) private var textEnvironment

    private let intent: PresentationIntent.IntentType?
    private let content: AttributedSubstring

    init(intent: PresentationIntent.IntentType?, content: AttributedSubstring) {
      self.intent = intent
      self.content = content
    }

    var body: some View {
      let runs = content.blockRuns(parent: intent)

      BlockVStack {
        ForEach(runs.indices, id: \.self) { index in
          let run = runs[index]

          UnorderedListItem(
            intent: run.intent,
            content: content[run.range]
          )
        }
      }
      .environment(\.resolvedListItemSpacing, listItemSpacing.resolve(in: textEnvironment))
      .environment(\.listItemSpacingEnabled, true)
    }
  }
}

extension StructuredText {
  fileprivate struct UnorderedListItem: View {
    @Environment(\.listItemStyle) private var listItemStyle
    @Environment(\.unorderedListMarker) private var unorderedListMarker

    private let intent: PresentationIntent.IntentType?
    private let content: AttributedSubstring

    init(
      intent: PresentationIntent.IntentType?,
      content: AttributedSubstring
    ) {
      self.intent = intent
      self.content = content
    }

    var body: some View {
      // A task, as GitHub writes one ("[ ] " or "[x] " first): a checkbox for its marker, and
      // its text without the brackets. (Fork addition.)
      let task = Self.task(in: content)
      let configuration = ListItemStyleConfiguration(
        marker: .init(task.map { AnyView(TaskMarker(isDone: $0.isDone)) } ?? AnyView(marker)),
        block: .init(
          BlockContent(
            parent: intent,
            content: task?.rest ?? content
          )
        ),
        indentationLevel: indentationLevel
      )
      let resolvedStyle = listItemStyle.resolve(configuration: configuration)

      AnyView(resolvedStyle)
    }

    static func task(in content: AttributedSubstring) -> (isDone: Bool, rest: AttributedSubstring)? {
      let mark = String(content.characters.prefix(4))
      guard mark == "[ ] " || mark == "[x] " || mark == "[X] " else { return nil }
      let start = content.characters.index(content.startIndex, offsetBy: 4)
      return (mark != "[ ] ", content[start...])
    }

    private var marker: some View {
      AnyView(
        unorderedListMarker.resolve(
          configuration: .init(
            indentationLevel: indentationLevel
          )
        )
      )
    }

    private var indentationLevel: Int {
      content.runs.first?.presentationIntent?.indentationLevel ?? 0
    }
  }
}

extension StructuredText {
  /// A task's checkbox, where a bullet would be, in the same column. (Fork addition.)
  fileprivate struct TaskMarker: View {
    let isDone: Bool

    var body: some View {
      SwiftUI.Image(systemName: isDone ? "checkmark.square" : "square")
        .textual.fontScale(0.85)
        .foregroundStyle(.secondary)
        .textual.frame(minWidth: .fontScaled(1.5), alignment: .trailing)
        .accessibilityLabel(isDone ? "Done" : "Not done")
    }
  }
}
