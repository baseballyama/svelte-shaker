// Loader for the native prop-scanner addon.
//
// Resolves the N-API binary across three layouts, in order:
//   1. A prebuilt, platform-named `.node` next to this file (the PUBLISHED
//      layout produced by `@napi-rs/cli`, e.g. `*.darwin-arm64.node`).
//   2. Any `*.node` next to this file (defensive: a differently-named prebuild).
//   3. The in-repo `cargo build` output under `target/{release,debug}` — copied
//      to a `.node` alongside this loader on demand — so tests and local dev work
//      straight off a `cargo build` with no `napi build` / publish step.
//
// The single export is `{ scan }`, matching the `#[napi] fn scan` in `src/lib.rs`.

const fs = require('node:fs');
const path = require('node:path');

const { platform, arch } = process;

/** The bare cargo cdylib filename for this platform (renamed to `.node` for require). */
const DYLIB = {
  darwin: 'libsvelte_shaker_engine_scan_native.dylib',
  linux: 'libsvelte_shaker_engine_scan_native.so',
  win32: 'svelte_shaker_engine_scan_native.dll',
}[platform];

function tryRequire(p) {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require(p);
  } catch {
    return null;
  }
}

function loadAddon() {
  // 1) Prebuilt platform-named `.node` (published layout).
  const prebuilt = path.join(
    __dirname,
    `svelte-shaker-engine-scan-native.${platform}-${arch}.node`,
  );
  if (fs.existsSync(prebuilt)) {
    const mod = tryRequire(prebuilt);
    if (mod) return mod;
  }

  // 2) In-repo cargo output (dev/test): copy `target/<profile>/<dylib>` to a
  //    `.node` and load. Checked BEFORE generic siblings so a fresh `cargo build`
  //    always wins over a stale `local-*.node` copy from an earlier build.
  if (DYLIB) {
    for (const profile of ['release', 'debug']) {
      const dylib = path.join(__dirname, 'target', profile, DYLIB);
      if (!fs.existsSync(dylib)) continue;
      const nodeCopy = path.join(__dirname, `local-${profile}.node`);
      // Refresh the copy only when the build is newer, so a rebuild is picked up
      // by the next fresh process without re-copying on every load.
      try {
        const srcMtime = fs.statSync(dylib).mtimeMs;
        const dstMtime = fs.existsSync(nodeCopy) ? fs.statSync(nodeCopy).mtimeMs : -1;
        if (srcMtime > dstMtime) fs.copyFileSync(dylib, nodeCopy);
      } catch {
        /* fall through to require attempt */
      }
      const mod = tryRequire(nodeCopy);
      if (mod) return mod;
    }
  }

  // 3) Any other `*.node` next to this file (defensive: a differently-named prebuild).
  let siblings = [];
  try {
    siblings = fs.readdirSync(__dirname);
  } catch {
    /* no dir listing */
  }
  for (const file of siblings) {
    if (file.endsWith('.node')) {
      const mod = tryRequire(path.join(__dirname, file));
      if (mod) return mod;
    }
  }

  throw new Error(
    `svelte-shaker-engine-scan-native: no native binary found for ${platform}-${arch} ` +
      `(looked for a prebuilt .node and a target/{release,debug} build)`,
  );
}

module.exports = loadAddon();
