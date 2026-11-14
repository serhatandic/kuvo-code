// Loaded before a real server in a test (`bun --preload`): its watch for hung servers looks every
// second rather than every 30, with the rest in proportion, so a test sees it work. It's set from code in
// the same process, so nothing around a real box can turn that on.
;(globalThis as { kuvoQuickHangWatch?: number }).kuvoQuickHangWatch = 1000
