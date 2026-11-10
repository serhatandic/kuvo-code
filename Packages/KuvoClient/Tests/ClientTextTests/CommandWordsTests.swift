import ClientText
import Testing

/// A command in the few words a line about it says (a background run finishing, one moved to the
/// background): what it runs, not the `cd`, the variables or the `timeout` before it, nor what reads
/// its output after it. As agents wrote them in real conversations.
struct CommandWordsTests {
    @Test func whatItRunsNotWhatSetsItUp() {
        #expect(CommandWords.short(#"cd /tmp/kuvo-373/phone && rm -rf /tmp/kuvo-373b/shots-phone && mkdir -p /tmp/kuvo-373b/shots-phone && TEST_RUNNER_KUVO_SHOTS_OUT=/tmp/kuvo-373b/shots-phone KUVO_HEAVY_SLOTS=2 ONLY=KuvoCodeMobileUITests/PictureGalleryTests timeout -k 30 2400 ../kuvo-ai/scripts/heavy.sh phone sh scripts/test-app.sh > /tmp/kuvo-373b/phone-ui.log 2>&1; echo exit $?; grep -E "error:|Test run|failed|passed" /tmp/kuvo-373b/phone-ui.log | head -30; ls /tmp/kuvo-373b/shots-phone"#)
                == "heavy.sh phone")
        #expect(CommandWords.short(#"ONLY=KuvoCodeTests/WorkQueueTests sh scripts/heavy.sh mac sh scripts/test-app.sh > /tmp/mac-wq.log 2>&1; echo "exit $?"; tail -30 /tmp/mac-wq.log"#) == "heavy.sh mac")
        #expect(CommandWords.short(#"cd /private/tmp/kuvo-402/phone; ONLY=KuvoCodeMobileTests/InboxListTests scripts/test-app.sh > /private/tmp/kuvo-402/build3.log 2>&1"#) == "test-app.sh")
        #expect(CommandWords.short(#"export PATH=$HOME/.bun/bin:$PATH; R=$PWD; scripts/heavy.sh box sh -c "cd x; bun test""#) == "heavy.sh box")
        #expect(CommandWords.short("swift test --disable-sandbox --filter BoxNoteTests 2>&1 | tail -20") == "swift test")
        #expect(CommandWords.short("npm run build") == "npm run build")
        #expect(CommandWords.short("bash -c 'cd web && npm test'") == "npm test")
    }

    @Test func onlySettingUpSaysItsFirstPart() {
        #expect(CommandWords.short("sleep 595; cat /private/tmp/kuvo-403/fix1.log") == "sleep 595")
        #expect(CommandWords.short("") == "")
    }

    @Test func aLongOneIsCut() {
        let words = CommandWords.short("a-very-long-program-name-that-goes-on-and-on-forever --flag")
        #expect(words.count == 40)
        #expect(words.hasSuffix("…"))
    }
}
