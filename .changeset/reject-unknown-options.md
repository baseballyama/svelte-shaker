---
'svelte-shaker': minor
---

`shaker()` now **throws** on an unknown option key, naming the key and listing the
options that do exist:

```
[vite-plugin-svelte-shaker] unknown option "preserv". Valid options are: entries,
preserve, monomorphize, engine, dev, parser, verbose. Check the spelling — an
option we do not read is an option that does not apply.
```

A typo used to be ignored, which is the same failure as a stale key: the build
succeeds with the setting not applied. For a misspelled `preserve` that means the
component you meant to protect ships over-shaken. TypeScript only catches this on
an object literal written inline, so a config assembled in a variable — or any JS
config — had nothing checking it.
