// A tiny mode-watcher-style config module: the names exported here collide with
// the prop KEYS Sub.svelte destructures (`modeStorageKey`, `themeStorageKey`),
// but inside Sub they are a DIFFERENT entity from the aliased local bindings.
export const modeStorageKey = { current: 'mode-watcher-mode' };
export const themeStorageKey = { current: 'mode-watcher-theme' };
