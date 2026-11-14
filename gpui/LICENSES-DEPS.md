# Dependencies and their licences

Kuvo is PolyForm Noncommercial. Every crate we add ourselves is MIT or Apache-2.0, checked
before adding. Nothing from Zed's GPL-3.0 crates is used or copied: only `gpui` and
`gpui_platform` (and the Apache-2.0 platform crates they pull in) come from Zed's repository.

## Added by us

| Crate | Licence | What for | Used by |
|---|---|---|---|
| gpui (Zed, rev dc93abce) | Apache-2.0 | The UI framework | kuvo_ui, kuvo_gallery, kuvo |
| gpui_platform (same rev) | Apache-2.0 | Opens the app on macOS (Linux, Windows later) | kuvo_gallery, kuvo |
| anyhow | MIT OR Apache-2.0 | Errors at the edges (asset loading, shots) | kuvo_ui, kuvo_gallery, kuvo |
| smallvec | MIT OR Apache-2.0 | Shaped lines in the text field | kuvo_ui |
| unicode-segmentation | MIT OR Apache-2.0 | Graphemes and words in the text field | kuvo_ui |
| pulldown-cmark | MIT | Parsing markdown | kuvo_ui |
| tree-sitter | MIT | Parsing code for highlighting | kuvo_ui |
| tree-sitter-highlight | MIT | Turning parses into highlights | kuvo_ui |
| tree-sitter-rust, -typescript, -javascript, -python, -json, -bash, -go | MIT | The grammars and their highlight queries | kuvo_ui |
| async-channel | Apache-2.0 OR MIT | Handing what a follow sees to a UI's executor or a thread | kuvo_box |
| base64 | MIT OR Apache-2.0 | A box's password in Basic auth; the script and bytes over SSH | kuvo_box |
| getrandom | MIT OR Apache-2.0 | The random part of a message's id | kuvo_box |
| libc | MIT OR Apache-2.0 | Reading a process's command line on macOS (is it the box's server?) | kuvo_box |
| percent-encoding | MIT OR Apache-2.0 | Writing a route's path and query | kuvo_box |
| serde, serde_json | MIT OR Apache-2.0 | Reading and writing a box's JSON | kuvo_box, kuvo (its stand-in box) |

GPUI's `test-support` feature (Apache-2.0, same crate) is used only by the tests and the
`shots` binary. `tempfile` (MIT OR Apache-2.0) gives `kuvo_box`'s tests and example folders of
their own. Every crate `kuvo_box` uses was already in the build (below); it adds none, and nor
does the app, `kuvo` (phase 2): it uses only crates already listed here.

GPUI also brings in other crates from Zed's repository, all Apache-2.0: `gpui_apple`,
`gpui_macos`, `gpui_macros`, `gpui_shared_string`, `gpui_util`, `collections`, `refineable`,
`sum_tree`, `http_client`, `scheduler` and the like (listed in full below).

**Services' marks** (`assets/marks/<service>.svg`, the usage rings' marks): OpenUsage's provider
icons (MIT, Copyright 2026 Robin Ebers), unchanged, as Kuvo Code already ships them in
`swift/UsageKit/Sources/UsageKit/Resources/ProviderIcons` (its licence:
`swift/UsageKit/LICENSE`, and its entry in `THIRD_PARTY_LICENSES.txt`). They're named by the
box's `service` ids (`claude`, `codex`, `copilot`, `cursor`, `grok`, `antigravity`, `openrouter`,
`zai`, `ollama`, `opencode`), which models.dev's logos (MIT, by provider: `anthropic`, `openai`…)
aren't, and models.dev has none for Cursor or Antigravity. The engine (opencode) is installed as a
single binary, with no provider marks to take. None comes from Zed. Each mark is its owner's trademark, shown only to name its
service.

**Adapted code:** parts of `kuvo_ui/src/text_field/` are adapted from GPUI's
`examples/input.rs` (Copyright 2022 - 2025 Zed Industries, Inc., Apache-2.0), modified; the
files say so. The license text is `Licenses/gpui.txt`, and GPUI has its entry in the repo's
`THIRD_PARTY_LICENSES.txt` (written by `scripts/third-party-licenses.sh`).

Assets: the icons in `assets/icons` are drawn for Kuvo and are Kuvo's own. No fonts are
bundled: the UI uses the system's SF Pro and SF Mono.

## Brought in by GPUI, and not MIT or Apache-2.0

All of these come with GPUI itself (its image decoders, font loading, ICU and hashing); none
was added by us. All are permissive, except two MPL-2.0 crates worth a decision:

| Crate | Licence | Comes from | Notes |
|---|---|---|---|
| option-ext 0.2 | MPL-2.0 | gpui_apple → zed-font-kit → dirs → dirs-sys | Linked into the app, unmodified. Kept (the lead's call); its notice and source location are in `THIRD_PARTY_LICENSES.txt`, its license in `Licenses/option-ext.txt`. |
| cbindgen 0.28 | MPL-2.0 | gpui_apple (build dependency) | A build-time tool only; not shipped. |
| icu_*, litemap, tinystr, writeable, yoke, zerofrom, zerotrie, zerovec, potential_utf | Unicode-3.0 | URL and text handling | Permissive. |
| tiny-skia, tiny-skia-path, exr, lebe, avif-serialize, ravif, sha1_smol | BSD-3-Clause | SVG and image decoding | Permissive; keep notices. |
| arrayref, av1-grain, rav1e, v_frame | BSD-2-Clause | Image decoding | Permissive; keep notices. |
| foldhash, slotmap, zlib-rs | Zlib | Hashing, GPUI's entity maps, compression | Permissive. |
| unicode-ident | (MIT OR Apache-2.0) AND Unicode-3.0 | Parsing (proc macros) | Permissive. |

GPUI and option-ext are in the repo's `THIRD_PARTY_LICENSES.txt` now. When the client ships,
the script should list every Rust crate in the shipped binary from `cargo metadata` (as
`scripts/deps-licenses.py` does here), with the notices the BSD crates ask for.

## Every crate in the build

Generated with `cargo metadata --format-version 1 --filter-platform aarch64-apple-darwin | scripts/deps-licenses.py`
(on this Mac, test and build dependencies included; Linux and Windows will add their own
platform crates, to be checked when the client is built there).

| Crate | Version | Licence |
|---|---|---|
| accesskit | 0.24.1 | MIT OR Apache-2.0 |
| accesskit_consumer | 0.38.0 | MIT OR Apache-2.0 |
| accesskit_macos | 0.26.3 | MIT OR Apache-2.0 |
| addr2line | 0.27.1 | Apache-2.0 OR MIT |
| adler2 | 2.0.1 | 0BSD OR MIT OR Apache-2.0 |
| aho-corasick | 1.1.5 | Unlicense OR MIT |
| aligned | 0.4.3 | MIT OR Apache-2.0 |
| aligned-vec | 0.6.4 | MIT |
| alloca | 0.4.0 | MIT |
| allocator-api2 | 0.2.21 | MIT OR Apache-2.0 |
| anes | 0.1.6 | MIT OR Apache-2.0 |
| anstyle | 1.0.14 | MIT OR Apache-2.0 |
| anyhow | 1.0.104 | MIT OR Apache-2.0 |
| arg_enum_proc_macro | 0.3.4 | MIT |
| arrayref | 0.3.9 | BSD-2-Clause |
| arrayvec | 0.7.8 | MIT OR Apache-2.0 |
| as-slice | 0.2.1 | MIT OR Apache-2.0 |
| async-channel | 2.5.0 | Apache-2.0 OR MIT |
| async-task | 4.7.1 | Apache-2.0 OR MIT |
| atomic | 0.5.3 | Apache-2.0/MIT |
| autocfg | 1.5.1 | Apache-2.0 OR MIT |
| av-scenechange | 0.14.1 | MIT |
| av1-grain | 0.2.5 | BSD-2-Clause |
| avif-serialize | 0.8.9 | BSD-3-Clause |
| backtrace | 0.3.77 | MIT OR Apache-2.0 |
| base64 | 0.22.1 | MIT OR Apache-2.0 |
| bench_metrics | 0.1.0 | Apache-2.0 |
| bit-set | 0.11.1 | Apache-2.0 OR MIT |
| bit-vec | 0.10.2 | Apache-2.0 OR MIT |
| bit_field | 0.10.4 | MIT OR Apache-2.0 |
| bitflags | 1.3.2 | MIT/Apache-2.0 |
| bitflags | 2.13.2 | MIT OR Apache-2.0 |
| bitstream-io | 4.10.0 | MIT/Apache-2.0 |
| block2 | 0.5.1 | MIT |
| block2 | 0.6.2 | MIT |
| borsh | 1.8.1 | MIT OR Apache-2.0 |
| borsh-derive | 1.8.1 | Apache-2.0 |
| built | 0.8.1 | MIT |
| bumpalo | 3.20.4 | MIT OR Apache-2.0 |
| bytemuck | 1.25.2 | Zlib OR Apache-2.0 OR MIT |
| bytemuck_derive | 1.12.1 | Zlib OR Apache-2.0 OR MIT |
| byteorder | 1.5.0 | Unlicense OR MIT |
| byteorder-lite | 0.1.0 | Unlicense OR MIT |
| bytes | 1.12.1 | MIT |
| cast | 0.3.0 | MIT OR Apache-2.0 |
| cbindgen | 0.28.0 | MPL-2.0 |
| cc | 1.11.2 | MIT OR Apache-2.0 |
| cfg-if | 1.0.5 | MIT OR Apache-2.0 |
| cfg_aliases | 0.2.2 | MIT |
| chacha20 | 0.10.2 | MIT OR Apache-2.0 |
| chrono | 0.4.45 | MIT OR Apache-2.0 |
| ciborium | 0.2.2 | Apache-2.0 |
| ciborium-io | 0.2.2 | Apache-2.0 |
| ciborium-ll | 0.2.2 | Apache-2.0 |
| clap | 4.6.7 | MIT OR Apache-2.0 |
| clap_builder | 4.6.7 | MIT OR Apache-2.0 |
| clap_lex | 1.1.1 | MIT OR Apache-2.0 |
| collections | 0.1.0 | Apache-2.0 |
| color_quant | 1.1.0 | MIT |
| concurrent-queue | 2.5.0 | Apache-2.0 OR MIT |
| convert_case | 0.10.0 | MIT |
| convert_case | 0.11.0 | MIT |
| core-foundation | 0.10.1 | MIT OR Apache-2.0 |
| core-foundation-sys | 0.8.7 | MIT OR Apache-2.0 |
| core-graphics | 0.24.0 | MIT OR Apache-2.0 |
| core-graphics-types | 0.2.0 | MIT OR Apache-2.0 |
| core-text | 21.0.0 | MIT OR Apache-2.0 |
| core_detect | 1.0.0 | MIT/Apache-2.0 |
| core_maths | 0.1.1 | MIT |
| crc32fast | 1.5.5 | MIT OR Apache-2.0 |
| criterion | 0.8.2 | Apache-2.0 OR MIT |
| criterion-plot | 0.8.2 | Apache-2.0 OR MIT |
| crossbeam-deque | 0.8.8 | MIT OR Apache-2.0 |
| crossbeam-epoch | 0.9.21 | MIT OR Apache-2.0 |
| crossbeam-queue | 0.3.14 | MIT OR Apache-2.0 |
| crossbeam-utils | 0.8.23 | MIT OR Apache-2.0 |
| ctor | 1.0.13 | Apache-2.0 OR MIT |
| data-url | 0.3.2 | MIT OR Apache-2.0 |
| derive_more | 2.1.1 | MIT |
| derive_more-impl | 2.1.1 | MIT |
| derive_refineable | 0.1.0 | Apache-2.0 |
| dirs | 6.0.0 | MIT OR Apache-2.0 |
| dirs-sys | 0.5.0 | MIT OR Apache-2.0 |
| dispatch2 | 0.3.1 | Zlib OR Apache-2.0 OR MIT |
| displaydoc | 0.2.7 | MIT OR Apache-2.0 |
| dyn-clone | 1.0.20 | MIT OR Apache-2.0 |
| either | 1.19.0 | MIT OR Apache-2.0 |
| embed-resource | 3.0.12 | MIT |
| enumn | 0.1.14 | MIT OR Apache-2.0 |
| equator | 0.4.2 | MIT |
| equator-macro | 0.4.2 | MIT |
| equivalent | 1.0.3 | Apache-2.0 OR MIT |
| errno | 0.3.15 | MIT OR Apache-2.0 |
| etagere | 0.2.15 | MIT/Apache-2.0 |
| euclid | 0.22.14 | MIT OR Apache-2.0 |
| event-listener | 5.4.2 | Apache-2.0 OR MIT |
| event-listener-strategy | 0.5.4 | Apache-2.0 OR MIT |
| exr | 1.74.3 | BSD-3-Clause |
| fastrand | 2.5.0 | Apache-2.0 OR MIT |
| fax | 0.2.7 | MIT |
| fdeflate | 0.3.7 | MIT OR Apache-2.0 |
| find-msvc-tools | 0.1.15 | MIT OR Apache-2.0 |
| fixedbitset | 0.5.9 | MIT OR Apache-2.0 |
| flate2 | 1.1.11 | MIT OR Apache-2.0 |
| float-cmp | 0.9.0 | MIT |
| float-ord | 0.3.2 | MIT / Apache-2.0 |
| flume | 0.12.0 | Apache-2.0/MIT |
| fnv | 1.0.7 | Apache-2.0 / MIT |
| foldhash | 0.2.0 | Zlib |
| fontdb | 0.23.0 | MIT |
| foreign-types | 0.5.0 | MIT/Apache-2.0 |
| foreign-types-macros | 0.2.4 | MIT/Apache-2.0 |
| foreign-types-shared | 0.3.1 | MIT/Apache-2.0 |
| form_urlencoded | 1.2.2 | MIT OR Apache-2.0 |
| futures | 0.3.34 | MIT OR Apache-2.0 |
| futures-channel | 0.3.34 | MIT OR Apache-2.0 |
| futures-concurrency | 7.7.1 | MIT OR Apache-2.0 |
| futures-core | 0.3.34 | MIT OR Apache-2.0 |
| futures-executor | 0.3.34 | MIT OR Apache-2.0 |
| futures-io | 0.3.34 | MIT OR Apache-2.0 |
| futures-lite | 2.6.1 | Apache-2.0 OR MIT |
| futures-macro | 0.3.34 | MIT OR Apache-2.0 |
| futures-sink | 0.3.34 | MIT OR Apache-2.0 |
| futures-task | 0.3.34 | MIT OR Apache-2.0 |
| futures-util | 0.3.34 | MIT OR Apache-2.0 |
| getrandom | 0.3.4 | MIT OR Apache-2.0 |
| getrandom | 0.4.3 | MIT OR Apache-2.0 |
| gif | 0.14.2 | MIT OR Apache-2.0 |
| gimli | 0.34.0 | MIT OR Apache-2.0 |
| gpui | 0.2.2 | Apache-2.0 |
| gpui_apple | 0.1.0 | Apache-2.0 |
| gpui_macos | 0.1.0 | Apache-2.0 |
| gpui_macros | 0.1.0 | Apache-2.0 |
| gpui_platform | 0.1.0 | Apache-2.0 |
| gpui_shared_string | 0.1.0 | Apache-2.0 |
| gpui_util | 0.1.0 | Apache-2.0 |
| half | 2.7.1 | MIT OR Apache-2.0 |
| hash32 | 0.3.1 | MIT OR Apache-2.0 |
| hashbrown | 0.16.1 | MIT OR Apache-2.0 |
| hashbrown | 0.17.1 | MIT OR Apache-2.0 |
| heapless | 0.9.3 | MIT OR Apache-2.0 |
| heck | 0.4.1 | MIT OR Apache-2.0 |
| heck | 0.5.0 | MIT OR Apache-2.0 |
| http | 1.5.0 | MIT OR Apache-2.0 |
| http-body | 1.1.0 | MIT |
| http_client | 0.1.0 | Apache-2.0 |
| iana-time-zone | 0.1.65 | MIT OR Apache-2.0 |
| icu_collections | 2.4.0 | Unicode-3.0 |
| icu_locale_core | 2.4.0 | Unicode-3.0 |
| icu_locale_fallback | 2.4.0 | Unicode-3.0 |
| icu_locale_fallback_data | 2.4.0 | Unicode-3.0 |
| icu_normalizer | 2.4.0 | Unicode-3.0 |
| icu_normalizer_data | 2.4.0 | Unicode-3.0 |
| icu_properties | 2.4.0 | Unicode-3.0 |
| icu_properties_data | 2.4.0 | Unicode-3.0 |
| icu_provider | 2.4.0 | Unicode-3.0 |
| icu_segmenter | 2.4.0 | Unicode-3.0 |
| icu_segmenter_data | 2.4.0 | Unicode-3.0 |
| idna | 1.1.0 | MIT OR Apache-2.0 |
| idna_adapter | 1.2.2 | Apache-2.0 OR MIT |
| image | 0.25.10 | MIT OR Apache-2.0 |
| image-webp | 0.2.4 | MIT OR Apache-2.0 |
| imagesize | 0.14.0 | MIT |
| imgref | 1.12.3 | CC0-1.0 OR Apache-2.0 |
| indexmap | 2.14.2 | Apache-2.0 OR MIT |
| inventory | 0.3.25 | MIT OR Apache-2.0 |
| itertools | 0.13.0 | MIT OR Apache-2.0 |
| itertools | 0.14.0 | MIT OR Apache-2.0 |
| itoa | 1.0.19 | MIT OR Apache-2.0 |
| jobserver | 0.1.35 | MIT OR Apache-2.0 |
| kurbo | 0.13.1 | Apache-2.0 OR MIT |
| lazy_static | 1.5.1 | MIT OR Apache-2.0 |
| lebe | 0.5.3 | BSD-3-Clause |
| libc | 0.2.191 | MIT OR Apache-2.0 |
| libm | 0.2.16 | MIT |
| link-section | 0.19.3 | Apache-2.0 OR MIT |
| linktime-proc-macro | 0.2.3 | Apache-2.0 OR MIT |
| litemap | 0.8.3 | Unicode-3.0 |
| lock_api | 0.4.14 | MIT OR Apache-2.0 |
| log | 0.4.35 | MIT OR Apache-2.0 |
| loop9 | 0.1.5 | MIT |
| lyon_geom | 1.0.20 | MIT OR Apache-2.0 |
| lyon_path | 1.0.19 | MIT OR Apache-2.0 |
| mach2 | 0.6.0 | BSD-2-Clause OR MIT OR Apache-2.0 |
| maybe-rayon | 0.1.1 | MIT |
| memchr | 2.8.3 | Unlicense OR MIT |
| memmap2 | 0.9.12 | MIT OR Apache-2.0 |
| miniz_oxide | 0.8.9 | MIT OR Zlib OR Apache-2.0 |
| miniz_oxide | 0.9.1 | MIT OR Zlib OR Apache-2.0 |
| moxcms | 0.8.1 | BSD-3-Clause OR Apache-2.0 |
| new_debug_unreachable | 1.0.6 | MIT |
| no_std_io2 | 0.9.4 | Apache-2.0 OR MIT |
| nom | 8.0.0 | MIT |
| noop_proc_macro | 0.3.0 | MIT |
| num-bigint | 0.4.8 | MIT OR Apache-2.0 |
| num-derive | 0.4.2 | MIT OR Apache-2.0 |
| num-integer | 0.1.47 | MIT OR Apache-2.0 |
| num-rational | 0.4.2 | MIT OR Apache-2.0 |
| num-traits | 0.2.19 | MIT OR Apache-2.0 |
| num_cpus | 1.17.0 | MIT OR Apache-2.0 |
| objc-sys | 0.3.5 | MIT |
| objc2 | 0.5.3 | MIT |
| objc2 | 0.6.5 | MIT |
| objc2-app-kit | 0.2.2 | MIT |
| objc2-app-kit | 0.3.2 | Zlib OR Apache-2.0 OR MIT |
| objc2-core-data | 0.2.2 | MIT |
| objc2-core-foundation | 0.3.2 | Zlib OR Apache-2.0 OR MIT |
| objc2-core-graphics | 0.3.2 | Zlib OR Apache-2.0 OR MIT |
| objc2-core-image | 0.2.2 | MIT |
| objc2-core-text | 0.3.2 | Zlib OR Apache-2.0 OR MIT |
| objc2-core-video | 0.3.2 | Zlib OR Apache-2.0 OR MIT |
| objc2-encode | 4.1.0 | MIT |
| objc2-foundation | 0.2.2 | MIT |
| objc2-foundation | 0.3.2 | MIT |
| objc2-io-surface | 0.3.2 | Zlib OR Apache-2.0 OR MIT |
| objc2-metal | 0.2.2 | MIT |
| objc2-metal | 0.3.2 | Zlib OR Apache-2.0 OR MIT |
| objc2-quartz-core | 0.2.2 | MIT |
| objc2-quartz-core | 0.3.2 | Zlib OR Apache-2.0 OR MIT |
| objc2-security | 0.3.2 | Zlib OR Apache-2.0 OR MIT |
| objc2-uniform-type-identifiers | 0.3.2 | Zlib OR Apache-2.0 OR MIT |
| objc2-user-notifications | 0.3.2 | Zlib OR Apache-2.0 OR MIT |
| object | 0.40.0 | Apache-2.0 OR MIT |
| once_cell | 1.21.4 | MIT OR Apache-2.0 |
| oorandom | 11.1.5 | MIT |
| option-ext | 0.2.0 | MPL-2.0 |
| page_size | 0.6.0 | MIT/Apache-2.0 |
| parking | 2.2.1 | Apache-2.0 OR MIT |
| parking_lot | 0.12.5 | MIT OR Apache-2.0 |
| parking_lot_core | 0.9.12 | MIT OR Apache-2.0 |
| paste | 1.0.15 | MIT OR Apache-2.0 |
| pastey | 0.1.1 | MIT OR Apache-2.0 |
| pathfinder_geometry | 0.5.1 | MIT/Apache-2.0 |
| pathfinder_simd | 0.5.6 | MIT OR Apache-2.0 |
| percent-encoding | 2.3.2 | MIT OR Apache-2.0 |
| pico-args | 0.5.0 | MIT |
| pin-project | 1.1.13 | Apache-2.0 OR MIT |
| pin-project-internal | 1.1.13 | Apache-2.0 OR MIT |
| pin-project-lite | 0.2.17 | Apache-2.0 OR MIT |
| plotters | 0.3.7 | MIT |
| plotters-backend | 0.3.7 | MIT |
| plotters-svg | 0.3.7 | MIT |
| png | 0.17.16 | MIT OR Apache-2.0 |
| png | 0.18.1 | MIT OR Apache-2.0 |
| pollster | 0.2.5 | Apache-2.0/MIT |
| pollster | 0.4.0 | Apache-2.0/MIT |
| polycool | 0.4.0 | MIT OR Apache-2.0 |
| postage | 0.5.0 | MIT |
| potential_utf | 0.1.6 | Unicode-3.0 |
| ppv-lite86 | 0.2.21 | MIT OR Apache-2.0 |
| proc-macro-crate | 3.5.0 | MIT OR Apache-2.0 |
| proc-macro2 | 1.0.107 | MIT OR Apache-2.0 |
| profiling | 1.0.18 | MIT OR Apache-2.0 |
| profiling-procmacros | 1.0.18 | MIT OR Apache-2.0 |
| proptest | 1.12.0 | MIT OR Apache-2.0 |
| proptest-macro | 0.6.0 | MIT OR Apache-2.0 |
| pulldown-cmark | 0.13.6 | MIT |
| pxfm | 0.1.30 | BSD-3-Clause OR Apache-2.0 |
| qoi | 0.4.1 | MIT/Apache-2.0 |
| quick-error | 1.2.3 | MIT/Apache-2.0 |
| quick-error | 2.0.1 | MIT/Apache-2.0 |
| quote | 1.0.47 | MIT OR Apache-2.0 |
| rand | 0.10.3 | MIT OR Apache-2.0 |
| rand | 0.9.5 | MIT OR Apache-2.0 |
| rand_chacha | 0.9.0 | MIT OR Apache-2.0 |
| rand_core | 0.10.1 | MIT OR Apache-2.0 |
| rand_core | 0.9.5 | MIT OR Apache-2.0 |
| rand_xorshift | 0.5.0 | MIT OR Apache-2.0 |
| rav1e | 0.8.1 | BSD-2-Clause |
| ravif | 0.13.0 | BSD-3-Clause |
| raw-window-handle | 0.6.2 | MIT OR Apache-2.0 OR Zlib |
| rayon | 1.12.0 | MIT OR Apache-2.0 |
| rayon-core | 1.13.0 | MIT OR Apache-2.0 |
| ref-cast | 1.0.27 | MIT OR Apache-2.0 |
| ref-cast-impl | 1.0.27 | MIT OR Apache-2.0 |
| refineable | 0.1.0 | Apache-2.0 |
| regex | 1.13.1 | MIT OR Apache-2.0 |
| regex-automata | 0.4.18 | MIT OR Apache-2.0 |
| regex-syntax | 0.8.11 | MIT OR Apache-2.0 |
| resvg | 0.46.0 | Apache-2.0 OR MIT |
| rgb | 0.8.53 | MIT |
| roxmltree | 0.21.2 | MIT OR Apache-2.0 |
| rustc-demangle | 0.1.28 | MIT/Apache-2.0 |
| rustc-hash | 2.1.3 | Apache-2.0 OR MIT |
| rustc_version | 0.4.1 | MIT OR Apache-2.0 |
| rustix | 1.1.6 | Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT |
| rustversion | 1.0.23 | MIT OR Apache-2.0 |
| rusty-fork | 0.3.1 | MIT/Apache-2.0 |
| rustybuzz | 0.20.1 | MIT |
| ryu | 1.0.23 | Apache-2.0 OR BSL-1.0 |
| same-file | 1.0.6 | Unlicense/MIT |
| scheduler | 0.1.0 | Apache-2.0 |
| schemars | 1.2.3 | MIT |
| schemars_derive | 1.2.3 | MIT |
| scopeguard | 1.2.0 | MIT OR Apache-2.0 |
| seahash | 4.1.0 | MIT |
| semver | 1.0.28 | MIT OR Apache-2.0 |
| serde | 1.0.229 | MIT OR Apache-2.0 |
| serde_core | 1.0.229 | MIT OR Apache-2.0 |
| serde_derive | 1.0.229 | MIT OR Apache-2.0 |
| serde_derive_internals | 0.30.0 | MIT OR Apache-2.0 |
| serde_json | 1.0.154 | MIT OR Apache-2.0 |
| serde_spanned | 0.6.9 | MIT OR Apache-2.0 |
| serde_spanned | 1.1.3 | MIT OR Apache-2.0 |
| serde_urlencoded | 0.7.1 | MIT/Apache-2.0 |
| sha1_smol | 1.0.1 | BSD-3-Clause |
| shlex | 2.0.1 | MIT OR Apache-2.0 |
| simd-adler32 | 0.3.10 | MIT |
| simd_helpers | 0.1.0 | MIT |
| simplecss | 0.2.2 | Apache-2.0 OR MIT |
| siphasher | 1.0.4 | MIT OR Apache-2.0 |
| slab | 0.4.12 | MIT |
| slotmap | 1.1.1 | Zlib |
| smallvec | 1.16.5 | MIT OR Apache-2.0 |
| smol_str | 0.3.7 | MIT OR Apache-2.0 |
| spin | 0.10.1 | MIT |
| spin | 0.9.9 | MIT |
| stable_deref_trait | 1.2.1 | MIT OR Apache-2.0 |
| static_assertions | 1.1.0 | MIT OR Apache-2.0 |
| streaming-iterator | 0.1.9 | MIT OR Apache-2.0 |
| strict-num | 0.1.1 | MIT |
| strum | 0.28.0 | MIT |
| strum_macros | 0.28.0 | MIT |
| sum_tree | 0.1.0 | Apache-2.0 |
| svg_fmt | 0.4.5 | MIT/Apache-2.0 |
| svgtypes | 0.16.2 | Apache-2.0 OR MIT |
| syn | 2.0.119 | MIT OR Apache-2.0 |
| syn | 3.0.10 | MIT OR Apache-2.0 |
| synstructure | 0.14.0 | MIT |
| taffy | 0.15.0 | MIT |
| tempfile | 3.27.0 | MIT OR Apache-2.0 |
| thiserror | 1.0.69 | MIT OR Apache-2.0 |
| thiserror | 2.0.21 | MIT OR Apache-2.0 |
| thiserror-impl | 1.0.69 | MIT OR Apache-2.0 |
| thiserror-impl | 2.0.21 | MIT OR Apache-2.0 |
| tiff | 0.11.3 | MIT |
| tiny-skia | 0.11.4 | BSD-3-Clause |
| tiny-skia-path | 0.11.4 | BSD-3-Clause |
| tinystr | 0.8.5 | Unicode-3.0 |
| tinytemplate | 1.2.1 | Apache-2.0 OR MIT |
| tinyvec | 1.13.3 | Zlib OR Apache-2.0 OR MIT |
| toml | 0.8.23 | MIT OR Apache-2.0 |
| toml | 1.2.1+spec-1.1.0 | MIT OR Apache-2.0 |
| toml_datetime | 0.6.11 | MIT OR Apache-2.0 |
| toml_datetime | 1.1.3+spec-1.1.0 | MIT OR Apache-2.0 |
| toml_edit | 0.22.27 | MIT OR Apache-2.0 |
| toml_edit | 0.25.19+spec-1.1.0 | MIT OR Apache-2.0 |
| toml_parser | 1.1.5+spec-1.1.0 | MIT OR Apache-2.0 |
| toml_write | 0.1.2 | MIT OR Apache-2.0 |
| toml_writer | 1.2.0+spec-1.1.0 | MIT OR Apache-2.0 |
| tracing | 0.1.44 | MIT |
| tracing-attributes | 0.1.31 | MIT |
| tracing-core | 0.1.36 | MIT |
| tree-sitter | 0.27.2 | MIT |
| tree-sitter-bash | 0.25.1 | MIT |
| tree-sitter-go | 0.25.0 | MIT |
| tree-sitter-highlight | 0.27.2 | MIT |
| tree-sitter-javascript | 0.25.0 | MIT |
| tree-sitter-json | 0.24.8 | MIT |
| tree-sitter-language | 0.1.9 | MIT |
| tree-sitter-python | 0.25.0 | MIT |
| tree-sitter-rust | 0.24.2 | MIT |
| tree-sitter-typescript | 0.23.2 | MIT |
| ttf-parser | 0.25.1 | MIT OR Apache-2.0 |
| unarray | 0.1.4 | MIT OR Apache-2.0 |
| unicase | 2.10.0 | MIT OR Apache-2.0 |
| unicode-bidi | 0.3.18 | MIT OR Apache-2.0 |
| unicode-bidi-mirroring | 0.4.0 | MIT/Apache-2.0 |
| unicode-ccc | 0.4.0 | MIT/Apache-2.0 |
| unicode-ident | 1.0.27 | (MIT OR Apache-2.0) AND Unicode-3.0 |
| unicode-properties | 0.1.3 | MIT/Apache-2.0 |
| unicode-script | 0.5.9 | MIT OR Apache-2.0 |
| unicode-segmentation | 1.13.3 | MIT OR Apache-2.0 |
| unicode-vo | 0.1.0 | MIT/Apache-2.0 |
| url | 2.5.8 | MIT OR Apache-2.0 |
| usvg | 0.46.0 | Apache-2.0 OR MIT |
| utf8_iter | 1.1.0 | Apache-2.0 OR MIT |
| utf_types | 1.0.0 | Apache-2.0 OR MIT |
| uuid | 1.29.2 | Apache-2.0 OR MIT |
| v_frame | 0.3.9 | BSD-2-Clause |
| version_check | 0.9.5 | MIT/Apache-2.0 |
| wait-timeout | 0.2.1 | MIT/Apache-2.0 |
| waker-fn | 1.2.0 | Apache-2.0 OR MIT |
| walkdir | 2.5.0 | Unlicense/MIT |
| wasm-bindgen | 0.2.130 | MIT OR Apache-2.0 |
| wasm-bindgen-macro | 0.2.130 | MIT OR Apache-2.0 |
| wasm-bindgen-macro-support | 0.2.130 | MIT OR Apache-2.0 |
| wasm-bindgen-shared | 0.2.130 | MIT OR Apache-2.0 |
| web-time | 1.1.0 | MIT OR Apache-2.0 |
| weezl | 0.1.12 | MIT OR Apache-2.0 |
| winnow | 0.7.15 | MIT |
| winnow | 1.0.5 | MIT |
| writeable | 0.6.4 | Unicode-3.0 |
| xmlwriter | 0.1.0 | MIT |
| y4m | 0.8.0 | MIT |
| yoke | 0.8.4 | Unicode-3.0 |
| yoke-derive | 0.8.4 | Unicode-3.0 |
| zed-font-kit | 0.14.1-zed | MIT OR Apache-2.0 |
| zerocopy | 0.8.63 | BSD-2-Clause OR Apache-2.0 OR MIT |
| zerocopy-derive | 0.8.63 | BSD-2-Clause OR Apache-2.0 OR MIT |
| zerofrom | 0.1.8 | Unicode-3.0 |
| zerofrom-derive | 0.1.8 | Unicode-3.0 |
| zerotrie | 0.2.5 | Unicode-3.0 |
| zerovec | 0.11.9 | Unicode-3.0 |
| zerovec-derive | 0.11.7 | Unicode-3.0 |
| zlib-rs | 0.6.8 | Zlib |
| zmij | 1.0.23 | MIT |
| ztracing | 0.1.0 | Apache-2.0 |
| ztracing_macro | 0.1.0 | Apache-2.0 |
| zune-core | 0.5.3 | MIT OR Apache-2.0 OR Zlib |
| zune-inflate | 0.2.54 | MIT OR Apache-2.0 OR Zlib |
| zune-jpeg | 0.5.15 | MIT OR Apache-2.0 OR Zlib |
