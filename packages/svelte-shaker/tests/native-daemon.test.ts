import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildAnalyzeInput } from '../src/index';
import type { ReadFile, Resolve } from '../src/index';

// The resident daemon (goal step 9): `init` must equal a cold `scan`, and `update`
// after an edit must equal a cold re-scan of the edited program — byte-for-byte,
// so an editor can re-scan incrementally without drift.
const require = createRequire(import.meta.url);
const addonPath = fileURLToPath(new URL('../engine-scan-native/index.cjs', import.meta.url));
const dylib = fileURLToPath(
  new URL(
    `../engine-scan-native/target/debug/${
      process.platform === 'darwin'
        ? 'libsvelte_shaker_engine_scan_native.dylib'
        : process.platform === 'win32'
          ? 'svelte_shaker_engine_scan_native.dll'
          : 'libsvelte_shaker_engine_scan_native.so'
    }`,
    import.meta.url,
  ),
);

interface Addon {
  scan: (inputJson: string) => string;
  ScanDaemon: new () => { init: (s: string) => string; update: (s: string) => string };
}
const addon: Addon | null = existsSync(dylib) ? (require(addonPath) as Addon) : null;

const resolve: Resolve = (source, importer) =>
  source.startsWith('.') ? new URL(source, `file://${importer}`).pathname : null;

async function payloadFor(files: Record<string, string>): Promise<string> {
  const readFile: ReadFile = (id) => files[id]!;
  const entries = Object.keys(files).filter((f) => f.endsWith('.svelte'));
  const input = await buildAnalyzeInput(entries, resolve, readFile);
  return JSON.stringify({ files: input.files, edges: input.edges });
}

const BASE: Record<string, string> = {
  '/App.svelte': "<script>import Child from './Child.svelte';</script>\n<Child a={1} />",
  '/Child.svelte': '<script>let { a, b } = $props();</script>\n{a}{b}',
};

describe.skipIf(!addon)('native ScanDaemon — incremental re-scan', () => {
  it('init equals a cold scan', async () => {
    const payload = await payloadFor(BASE);
    const cold = addon!.scan(payload);
    const daemon = new addon!.ScanDaemon();
    expect(daemon.init(payload)).toBe(cold);
    // `b` is declared but never passed -> reported.
    expect(JSON.parse(cold)).toEqual({ '/Child.svelte': [{ name: 'b', start: 17, end: 18 }] });
  });

  it('update after passing the prop drops the report, matching a cold re-scan', async () => {
    const daemon = new addon!.ScanDaemon();
    daemon.init(await payloadFor(BASE));

    // Now pass `b` at the call site: the report must become empty.
    const edited = {
      ...BASE,
      '/App.svelte': "<script>import Child from './Child.svelte';</script>\n<Child a={1} b={2} />",
    };
    const editedPayload = await payloadFor(edited);
    const cold = addon!.scan(editedPayload);
    // The daemon only re-parses the changed file (App), reusing Child's cached model.
    const incremental = daemon.update(
      JSON.stringify({
        files: [{ id: '/App.svelte', code: edited['/App.svelte'] }],
        edges: JSON.parse(editedPayload).edges,
      }),
    );
    expect(incremental).toBe(cold);
    expect(JSON.parse(incremental)).toEqual({});
  });

  it('update that newly omits a prop re-introduces the report', async () => {
    const daemon = new addon!.ScanDaemon();
    // Start from the state where `b` IS passed (no report).
    const passed = {
      ...BASE,
      '/App.svelte': "<script>import Child from './Child.svelte';</script>\n<Child a={1} b={2} />",
    };
    daemon.init(await payloadFor(passed));

    // Edit the call site to stop passing `b`.
    const editedPayload = await payloadFor(BASE);
    const cold = addon!.scan(editedPayload);
    const incremental = daemon.update(
      JSON.stringify({
        files: [{ id: '/App.svelte', code: BASE['/App.svelte'] }],
        edges: JSON.parse(editedPayload).edges,
      }),
    );
    expect(incremental).toBe(cold);
    expect(JSON.parse(incremental)).toEqual({
      '/Child.svelte': [{ name: 'b', start: 17, end: 18 }],
    });
  });

  it('removing the only caller skips the now-zero-call-site child (matches cold scan)', async () => {
    const daemon = new addon!.ScanDaemon();
    daemon.init(await payloadFor(BASE));

    // Drop App.svelte entirely: Child now has zero call sites -> skipped (entry/unused).
    const onlyChild = { '/Child.svelte': BASE['/Child.svelte']! };
    const coldPayload = await payloadFor(onlyChild);
    const cold = addon!.scan(coldPayload);
    const incremental = daemon.update(
      JSON.stringify({ files: [], edges: JSON.parse(coldPayload).edges, removed: ['/App.svelte'] }),
    );
    expect(incremental).toBe(cold);
    expect(JSON.parse(incremental)).toEqual({});
  });
});
