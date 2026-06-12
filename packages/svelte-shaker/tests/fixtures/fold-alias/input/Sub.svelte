<script>
  import { modeStorageKey, themeStorageKey } from './keys.js';
  let {
    themeStorageKey: themeStorageKeyProp = 'mode-watcher-theme',
    modeStorageKey: modeStorageKeyProp = 'mode-watcher-mode',
    disableHeadScriptInjection = false,
  } = $props();
  modeStorageKey.current = modeStorageKeyProp;
  themeStorageKey.current = themeStorageKeyProp;
</script>

{#if disableHeadScriptInjection}
  <p>no head script</p>
{:else}
  <p>mode key: {modeStorageKeyProp}</p>
{/if}
