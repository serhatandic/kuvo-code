import SwiftUI

extension StructuredText {
  /// A thematic break style inspired by GitHub’s rendering.
  public struct GitHubThematicBreakStyle: ThematicBreakStyle {
    /// Creates the GitHub thematic break style.
    public init() {}

    public func makeBody(configuration _: Configuration) -> some View {
      // One thin line in a table's colour, the same room above and below.
      Rectangle()
        .fill(DynamicColor.gitHubBorder)
        .frame(height: 1)
        .textual.blockSpacing(.init(top: 24, bottom: 24))
    }
  }
}

extension StructuredText.ThematicBreakStyle where Self == StructuredText.GitHubThematicBreakStyle {
  /// A GitHub-like thematic break style.
  public static var gitHub: Self {
    .init()
  }
}

#Preview {
  StructuredText(
    markdown: """
      The sky above the port was the color of television, tuned to a dead channel.

      ---

      It was a bright cold day in April, and the clocks were striking thirteen.
      """
  )
  .padding()
  .textual.paragraphStyle(.gitHub)
  .textual.thematicBreakStyle(.gitHub)
}
