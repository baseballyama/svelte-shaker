import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);

/**
 * Load the native (napi) addon through its OWN loader (`engine-scan-native/index.cjs` —
 * the same resolution the plugin uses: a published/prebuilt `.node`, else the local
 * `cargo build` output), or `null` when no binary can be loaded.
 *
 * Native tests key `skipIf` on this so a skip means "genuinely not loadable on this
 * machine" — not a guessed `target/debug/*.dylib` path, which could skip a release-only
 * build into a silent, assertion-free green (CI builds the addon and must actually run
 * the byte-identity assertions).
 */
export function loadNativeAddon<T = unknown>(): T | null {
  try {
    return require(fileURLToPath(new URL('../engine-scan-native/index.cjs', import.meta.url))) as T;
  } catch {
    return null;
  }
}
