import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { EXPECTED_ENGINE_API_VERSION } from '../src/native-engine';

/**
 * The native addon is versioned and published by hand (it is not a workspace package,
 * so changesets never bumps it), while the wrapper pins it with a `~0.N.0` range. If
 * the engine API generation is bumped without a matching native release and range,
 * the wrapper ships depending on a binary its loader rejects and the native engine is
 * silently never used (issue #204). These assertions make that skew a test failure.
 */

const NATIVE_PACKAGE = 'svelte-shaker-engine-scan-native';

const readJson = (rel: string): Record<string, unknown> =>
  JSON.parse(readFileSync(new URL(rel, import.meta.url), 'utf-8')) as Record<string, unknown>;

const rustApiVersion = (): number => {
  const src = readFileSync(new URL('../engine-scan-native/src/lib.rs', import.meta.url), 'utf-8');
  const m = /pub fn engine_api_version\(\) -> u32 \{\s*(\d+)\s*\}/.exec(src);
  if (!m?.[1]) throw new Error('engine_api_version() not found in engine-scan-native/src/lib.rs');
  return Number(m[1]);
};

describe('native engine version lockstep', () => {
  const nativeVersion = readJson('../engine-scan-native/package.json')['version'];
  const optionalDeps = readJson('../package.json')['optionalDependencies'] as Record<
    string,
    string
  >;

  it('the Rust addon and the JS loader agree on the engine API version', () => {
    expect(rustApiVersion()).toBe(EXPECTED_ENGINE_API_VERSION);
  });

  it('the native package minor version equals the engine API version', () => {
    expect(nativeVersion).toMatch(new RegExp(`^0\\.${EXPECTED_ENGINE_API_VERSION}\\.\\d+$`));
  });

  // `~0.N.x` still admits native patch releases, but never another API generation.
  it("the wrapper's optional dependency range targets that same minor", () => {
    expect(optionalDeps[NATIVE_PACKAGE]).toMatch(
      new RegExp(`^~0\\.${EXPECTED_ENGINE_API_VERSION}\\.\\d+$`),
    );
  });
});
