import { existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, resolve as resolvePath } from 'node:path';
import { describe, expect, it } from 'vitest';
import { svelteShakerWithMono, type ComponentId, type MonomorphizeOptions } from '../src/index';
import { svelteShakerNativeWithMono, tryLoadNativeEngine } from '../src/native-engine';
import { tryLoadRsvelteOwnSize } from '../src/rsvelte-parse';
import { fsReadFile, fsResolve } from '../src/scan';

// The gate's size proxy: the TS reference measures it with `@rsvelte/compiler`
// (`compile_client`), the native engine computes the SAME proxy in-process from the
// pinned rsvelte crate. Byte-parity here is exactly what pins those two in sync.
const ownSize = tryLoadRsvelteOwnSize() ?? ((): number | null => null);

// The PRODUCTION native path — `svelteShakerNativeWithMono` (what vite.ts calls) — must
// produce byte-for-byte the SAME files + variants as the audited TS `svelteShakerWithMono`.
// This drives the whole route: the facts-provider crawl (seed parsed by the session,
// children discovered via `parseMore`), the in-process shake, and the outer
// svelte/compiler revert cascade. It is the M3 plugin-level gate.
const engine = tryLoadNativeEngine();

const MONO_ON: MonomorphizeOptions = { enabled: true, maxVariants: 8, minSavings: 0 };
const MONO_OFF: MonomorphizeOptions = { enabled: false, maxVariants: 8, minSavings: 0 };

/** `<childId>::v<n>` -> `<childId>?shaker_variant=<n>` (mirrors vite.ts). */
function variantSpecifier(variantId: string): string {
  const sep = variantId.lastIndexOf('::v');
  return `${variantId.slice(0, sep)}?shaker_variant=${variantId.slice(sep + 3)}`;
}

type Shaken = { files: Record<ComponentId, string>; variants: Record<string, string> };

async function tsShake(entry: ComponentId, mono: MonomorphizeOptions): Promise<Shaken> {
  const result = await svelteShakerWithMono(
    entry,
    fsResolve,
    fsReadFile,
    mono,
    variantSpecifier,
    undefined,
    undefined,
    ownSize,
  );
  const variants: Record<string, string> = {};
  for (const v of result.mono.variants.values()) variants[variantSpecifier(v.id)] = v.code;
  return { files: result.files, variants };
}

async function nativeShake(entry: ComponentId, mono: MonomorphizeOptions): Promise<Shaken> {
  const result = await svelteShakerNativeWithMono(engine!, entry, fsResolve, fsReadFile, mono);
  return { files: result.files, variants: Object.fromEntries(result.variants) };
}

const FIXTURES = resolvePath(__dirname, 'fixtures');
const fixtureEntries = readdirSync(FIXTURES, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => join(FIXTURES, d.name, 'input', 'App.svelte'))
  .filter((p) => existsSync(p));
const exampleE2eEntries = [
  fileURLToPath(new URL('../../example/src/App.svelte', import.meta.url)),
  fileURLToPath(new URL('../../e2e/src/App.svelte', import.meta.url)),
].filter((p) => existsSync(p));
const entries = [...fixtureEntries, ...exampleE2eEntries];

describe.skipIf(!engine)(
  'svelteShakerNativeWithMono matches svelteShakerWithMono (plugin route)',
  () => {
    for (const entry of entries) {
      const label = entry.split('/fixtures/')[1] ?? entry.split('/packages/')[1] ?? entry;
      it(`${label}: files + variants match (mono on & off)`, async () => {
        for (const mono of [MONO_ON, MONO_OFF]) {
          const ts = await tsShake(entry, mono);
          const native = await nativeShake(entry, mono);
          expect(native.files, `${label} files (mono=${mono.enabled})`).toEqual(ts.files);
          expect(native.variants, `${label} variants (mono=${mono.enabled})`).toEqual(ts.variants);
        }
      });
    }
  },
);
