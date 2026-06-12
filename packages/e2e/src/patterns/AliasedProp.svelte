<script lang="ts">
  // Pattern 2: aliased destructure + same-named import — the exact structure
  // that triggered issue #37 in mode-watcher's ModeWatcher.svelte.
  //
  // `storageKey` is BOTH the import binding below AND the prop name.
  // `storageKeyProp` is the alias: the local variable the body uses.
  // When the shaker folds the never-passed `storageKey` prop it must replace
  // every reference to `storageKeyProp` — not just remove it from $props().
  // Failing to do so leaves `storageKey.value = storageKeyProp` alive with
  // no binding for `storageKeyProp`, which throws ReferenceError during SSR.
  import { storageKey } from './aliased-constants.ts';

  let {
    storageKey: storageKeyProp = 'aliased-default',
  }: { storageKey?: string } = $props();

  // Synchronous mutation that runs at component instantiation time in SSR —
  // exactly the pattern from mode-watcher that surfaces the ReferenceError.
  storageKey.value = storageKeyProp;
</script>

<span data-key={storageKeyProp}>{storageKeyProp}</span>
