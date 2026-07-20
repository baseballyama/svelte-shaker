---
'svelte-shaker': minor
---

Remove a trailing `{:else}` arm the reachable value set can never hit.

When an if/else-if chain ends in `{:else}` and every test is driven by a single
narrowed prop (`variant ∈ {'primary','secondary'}`), the shaker now enumerates
that value set and checks each value against the arms: if every value makes some
earlier test provably fire, the `{:else}` body is unreachable and is deleted —
taking its call sites, imports, and any `<style>` rules that only its markup could
produce along with it (via the existing cascade and CSS pruning). This is a
soundness-preserving precision improvement: a value whose test cannot be settled,
a chain driven by two or more narrowed props, or a value set larger than 64 all
leave the `{:else}` untouched.
