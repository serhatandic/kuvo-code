import ClientDesign
import Testing

/// What VoiceOver says for a chip: its name, title and where it stands; one gone from its source
/// says so, as its dimmed mark shows it.
@Suite struct WorkItemChipTests {
    @Test func aChipGoneFromItsSourceSaysSo() {
        #expect(WorkItemChip.spoken(name: "GitHub issue app#12", title: "Upload retries", mark: .done) == "GitHub issue app#12, Upload retries, done")
        #expect(WorkItemChip.spoken(name: "GitHub issue app#12", title: "Upload retries", mark: .done, gone: true) == "GitHub issue app#12, Upload retries, done, gone")
    }
}
