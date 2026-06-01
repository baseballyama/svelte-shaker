import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ComponentId } from './ir';

/**
 * Recursively collect every `.svelte` file under `dir` (skipping `node_modules`
 * and dot-directories).  A Shell helper, kept out of the env-free engine core
 * (docs/ARCHITECTURE.md §5): plugins use it to seed the whole-program crawl.
 */
export function collectSvelteFiles(dir: string): ComponentId[] {
  const out: ComponentId[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectSvelteFiles(full));
    else if (entry.isFile() && entry.name.endsWith('.svelte')) out.push(full);
  }
  return out;
}
