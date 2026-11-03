import ClientChanges
import ClientDesign
import OpenCodeKit
import SwiftUI

/// A short diff in a recessed well, for a tool call or a permission request: the same lines,
/// numbers and colors as the Changes panel, without folding or comments.
struct DiffView: View {
    let diff: FileDiff
    /// The file's name over the lines; nil when what it's under names the file already.
    var title: String?
    /// Long diffs are cut here, with a note.
    var maxLines = Int.max

    @Environment(\.colorScheme) private var scheme
    @Environment(\.cardIsFocused) private var cardIsFocused
    @State private var highlighting: DiffHighlighting?

    private static let shape = RoundedRectangle(cornerRadius: 10)

    private var file: ChangedFile { DiffParser.file(from: diff, directory: "/") }

    var body: some View {
        let file = file
        let shown = Array(file.lines.prefix(maxLines))
        let gutter = DiffLineRow.gutterWidth(for: shown)
        // A new or emptied file with nothing in it: its name alone, with no line under it.
        let hasBody = !file.lines.isEmpty || file.isTooBig || file.isBinary
        VStack(alignment: .leading, spacing: 0) {
            if let title {
                HStack {
                    Image(systemName: diff.status == .added ? "doc.badge.plus" : diff.status == .deleted ? "doc.badge.minus" : "doc")
                        .foregroundStyle(.secondary)
                    Text(title)
                        .font(.callout.weight(.medium))
                        .lineLimit(1)
                        .truncationMode(.head)
                    Spacer()
                    DiffStat(additions: diff.additions, deletions: diff.deletions)
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 8)

                // The same line as the well's edge, not a darker rule.
                if hasBody {
                    Rectangle()
                        .fill(Surface.wellBorder(scheme))
                        .frame(height: 1)
                }
            }

            if !shown.isEmpty {
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(Array(shown.enumerated()), id: \.offset) { index, line in
                        if line.gapBefore, index > 0 {
                            Image(systemName: "ellipsis")
                                .font(.system(size: 10, weight: .semibold))
                                .foregroundStyle(.tertiary)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .padding(.leading, gutter / 2)
                                .frame(height: 18)
                        }
                        DiffLineRow(line: line, runs: highlighting?.runs(for: line, at: index), gutterWidth: gutter)
                    }
                }
                .padding(.vertical, 4)
                .textSelection(.enabled)
            }

            // Nothing line by line: said, rather than an empty well.
            if file.lines.isEmpty, file.isTooBig || file.isBinary {
                Text(file.isTooBig ? "Too big to show" : "Binary")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 6)
            }

            if file.lines.count > maxLines {
                Text("\(file.lines.count - maxLines) more lines")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 6)
            }
        }
        .clipShape(Self.shape)
        // Solid under the well: on a permission card's glass, code needs a surface of its own.
        .background(Surface.cardFill(scheme, focused: cardIsFocused), in: Self.shape)
        .recessedWell(Self.shape)
        .task(id: diff) {
            var named = file
            named.path = diff.file
            highlighting = await DiffHighlighting.make(for: named)
        }
    }
}
