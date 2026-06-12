// Mutable state object used by AliasedProp.svelte to mirror mode-watcher's
// `modeStorageKey` import pattern: the prop NAME collides with the import
// binding, and the prop ALIAS is what the body mutates.
export const storageKey = { value: 'initial-key' };
