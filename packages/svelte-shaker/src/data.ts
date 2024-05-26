// ----------------------------------------------------------------------
// Manage dependencies of Svelte components.
// ----------------------------------------------------------------------

type AbsolutePath = string;
type Dependant = { path: AbsolutePath; props: { name: string; value: any } };

export const dependencies: Map<AbsolutePath, Dependant[]> = new Map();

// ----------------------------------------------------------------------
// Manage Svelte files.
// ----------------------------------------------------------------------

export const svelteFiles = new Map<AbsolutePath, string>();
