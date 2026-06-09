---
'svelte-shaker': patch
---

Don't fold a never-passed prop's literal into a **TS type-member key**.

When a prop is only ever read at its default (so it folds to a literal and is dropped from `$props()`), every *value* reference to it is substituted with that literal. The reference walk's `isNonReference` guard already excluded object-literal property keys, member-expression properties, and import/export specifiers — but **not** the key of a `TSPropertySignature` / `TSMethodSignature`. So a component whose prop is also a member of its `Props` type:

```ts
interface Props {
  width?: number;
  height?: number;
}
const { width = 36, height = 20 }: Props = $props();
```

had its type corrupted — `width?: number` became `36?: number`, `height?: number` became `20?: number` (and a string default like `label = '…'` produced a `'…'?: string` key). The type text is erased at compile, so this was byte-wrong but never a runtime fault; still, the type member must keep its name. `isNonReference` now skips a non-computed `TSPropertySignature`/`TSMethodSignature` key, so the interface member is preserved while the body's value reads still fold. The Rust/WASM engine mirrors the same guard (differential oracle green).
