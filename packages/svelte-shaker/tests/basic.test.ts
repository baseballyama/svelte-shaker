import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { svelteShaker, fsResolve } from '../src/index';
import { analyze } from '../src/analyze';
import { assertCompiles, cleanTmp, renderHtml, renderGraphHtml } from './diff';

const FIXTURES = resolve(__dirname, 'fixtures');
const readFile = (id: string) => readFileSync(id, 'utf-8');

afterAll(() => cleanTmp());

describe('svelte-shaker / fixtures', () => {
  const dirs = readdirSync(FIXTURES, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => join(FIXTURES, d.name));

  for (const dir of dirs) {
    it(`${basename(dir)}: shaken output matches expected & still compiles`, async () => {
      const entry = join(dir, 'input', 'App.svelte');
      const out = await svelteShaker(entry, fsResolve, readFile);

      for (const [id, code] of Object.entries(out)) {
        const name = basename(id);
        // `actual/` is a gitignored debug artifact, so create it on a fresh checkout.
        mkdirSync(join(dir, 'actual'), { recursive: true });
        writeFileSync(join(dir, 'actual', name), code); // for inspection on failure
        assertCompiles(code, name);
        const expected = readFileSync(join(dir, 'expected', name), 'utf-8');
        expect(code, name).toBe(expected);
      }
    });
  }
});

describe('svelte-shaker / soundness (differential SSR)', () => {
  it('basic1: shaking a dead prop branch preserves observable HTML', async () => {
    const dir = join(FIXTURES, 'basic1');
    const original = readFileSync(join(dir, 'input', 'Sub.svelte'), 'utf-8');
    const entry = join(dir, 'input', 'App.svelte');
    const out = await svelteShaker(entry, fsResolve, readFile);
    const shaken = out[join(dir, 'input', 'Sub.svelte')]!;

    // `hasIcon` is proven to be `false` at every call site in this app, so the
    // observable output must be identical for that occurring value.
    const props = { hasIcon: false };
    const before = await renderHtml(original, props, 'Sub.svelte');
    const after = await renderHtml(shaken, props, 'Sub.svelte');

    expect(after).toBe(before);
    expect(before).toContain('This is Sub Component');
    expect(before).not.toContain('Icon</p>'); // the dead branch was never visible
  });

  it('spread-after: only the post-spread prop folds; pre-spread stays (partial bail)', async () => {
    const dir = join(FIXTURES, 'spread-after');
    const entry = join(dir, 'input', 'App.svelte');

    // Analysis: `b` (after the spread) is a clean singleton -> foldable; `a`
    // (before the spread) is ⊤ because the spread may override it.
    const { plans } = await analyze(entry, fsResolve, readFile);
    const plan = plans.get(join(dir, 'input', 'C.svelte'))!;
    expect(plan.constFold.has('b')).toBe(true);
    expect(plan.constFold.get('b')).toBe(2);
    expect(plan.constFold.has('a')).toBe(false);
    expect(plan.valueSets.get('a')!.top).toBe(true); // pre-spread -> Unknown
    expect(plan.valueSets.get('b')!.top).toBe(false);

    const out = await svelteShaker(entry, fsResolve, readFile);
    const shaken = out[join(dir, 'input', 'C.svelte')]!;
    expect(shaken).not.toMatch(/\{#if b\}/); // b folded away
    expect(shaken).toContain('a === 1'); // a NOT folded

    // Soundness for the values that actually occur at runtime: the spread
    // (`{ a: 99 }`) overrides the pre-spread `a={1}`, and `b={2}` overrides the
    // spread. So C is really rendered with a=99, b=2.
    const original = readFileSync(join(dir, 'input', 'C.svelte'), 'utf-8');
    const props = { a: 99, b: 2 };
    const before = await renderHtml(original, props, 'C.svelte');
    const after = await renderHtml(shaken, props, 'C.svelte');
    expect(after).toBe(before);
    expect(before).not.toContain('A is one'); // a===1 is false at runtime
    expect(before).toContain('B is truthy');
  });

  it('narrow-variant (L1.5): an unreachable arm is removed, the prop is kept', async () => {
    const dir = join(FIXTURES, 'narrow-variant');
    const entry = join(dir, 'input', 'App.svelte');

    // Analysis: `variant ∈ {'primary','secondary'}` across the two call sites —
    // a value set of size 2, so it is narrowed (not folded, not dropped).
    const { plans } = await analyze(entry, fsResolve, readFile);
    const plan = plans.get(join(dir, 'input', 'Btn.svelte'))!;
    expect(plan.constFold.has('variant')).toBe(false); // not a single constant
    expect([...(plan.narrow.get('variant') ?? [])].sort()).toEqual([
      'primary',
      'secondary',
    ]);

    const out = await svelteShaker(entry, fsResolve, readFile);
    const shaken = out[join(dir, 'input', 'Btn.svelte')]!;
    // The `danger` arm can never be taken -> gone. The primary/else arms remain.
    expect(shaken).not.toContain('DANGER');
    expect(shaken).not.toContain("variant === 'danger'");
    expect(shaken).toContain("{#if variant === 'primary'}"); // promoted to head
    expect(shaken).toContain('<b>P</b>');
    expect(shaken).toContain('<i>other</i>');
    // The prop is still genuinely used, so it stays in the signature.
    expect(shaken).toMatch(/let \{ variant \}/);

    // Soundness: for BOTH values that actually occur, the observable HTML is
    // identical before and after shaking (the removed arm was unreachable).
    const original = readFileSync(join(dir, 'input', 'Btn.svelte'), 'utf-8');
    for (const variant of ['primary', 'secondary'] as const) {
      const before = await renderHtml(original, { variant }, 'Btn.svelte');
      const after = await renderHtml(shaken, { variant }, 'Btn.svelte');
      expect(after, variant).toBe(before);
    }
    // The two occurring values render the two surviving arms, never `danger`.
    expect(
      await renderHtml(shaken, { variant: 'primary' }, 'Btn.svelte'),
    ).toContain('<b>P</b>');
    expect(
      await renderHtml(shaken, { variant: 'secondary' }, 'Btn.svelte'),
    ).toContain('<i>other</i>');
  });

  it('rest-prop: a declared prop folds & drops despite the callee reading `...rest`', async () => {
    const dir = join(FIXTURES, 'rest-prop');
    const entry = join(dir, 'input', 'App.svelte');

    const { plans } = await analyze(entry, fsResolve, readFile);
    const plan = plans.get(join(dir, 'input', 'Box.svelte'))!;
    expect(plan.bail).toBe(false); // rest must NOT block folding declared props
    expect(plan.constFold.get('hidden')).toBe(true);

    const out = await svelteShaker(entry, fsResolve, readFile);
    const shaken = out[join(dir, 'input', 'Box.svelte')]!;
    expect(shaken).toMatch(/let \{ \.\.\.rest \}/); // `hidden` gone, only rest left
    expect(shaken).not.toMatch(/\{#if hidden\}/); // dead branch unwrapped
    expect(shaken).not.toMatch(/hidden:\s*boolean/); // type member dropped too

    // The whole-program rewrite changes the callee AND its call site together,
    // so soundness compares each side under the props it actually receives:
    //  - original Box: the app passed `hidden={true} id="x" class="box"`, and
    //    `hidden` is destructured out, so the div's `...rest` is {id, class}.
    //  - shaken Box: the app no longer passes `hidden` (attribute removed), so
    //    the div's `...rest` is again {id, class}. Observably identical.
    const original = readFileSync(join(dir, 'input', 'Box.svelte'), 'utf-8');
    const before = await renderHtml(
      original,
      { hidden: true, id: 'x', class: 'box' },
      'Box.svelte',
    );
    const after = await renderHtml(
      shaken,
      { id: 'x', class: 'box' },
      'Box.svelte',
    );
    expect(after).toBe(before);
    expect(before).toContain('hidden flag is set'); // true branch is live
    expect(before).toContain('id="x"'); // rest-forwarded attribute preserved
  });

  it('fold-ternary: const prop substitutes into class:/attr/expr and folds the ternary', async () => {
    const dir = join(FIXTURES, 'fold-ternary');
    const entry = join(dir, 'input', 'App.svelte');

    // `isActive` is proven `false` at the sole call site -> a clean constFold.
    const { plans } = await analyze(entry, fsResolve, readFile);
    const plan = plans.get(join(dir, 'input', 'Badge.svelte'))!;
    expect(plan.constFold.get('isActive')).toBe(false);

    const out = await svelteShaker(entry, fsResolve, readFile);
    const shaken = out[join(dir, 'input', 'Badge.svelte')]!;

    // (1) The literal is substituted into every expression position: the
    //     `class:` directive, a plain attribute, and the ternary `test`.
    expect(shaken).toContain('class:active={false}');
    expect(shaken).toContain('data-state={false}');
    // (2) The ternary is folded to its taken (else) arm — the dead arm is gone.
    expect(shaken).toContain("{'off'}");
    expect(shaken).not.toContain("'on'");
    expect(shaken).not.toMatch(/\?\s*'on'/); // no surviving `? 'on'` ternary
    // The prop collapsed everywhere, so it leaves the signature & the call site.
    expect(shaken).not.toMatch(/let \{ isActive \}/);
    expect(out[entry]!).toContain('<Badge />');

    // Soundness: for the value that actually occurs (isActive=false) the
    // observable HTML is identical before and after shaking.
    const original = readFileSync(join(dir, 'input', 'Badge.svelte'), 'utf-8');
    const props = { isActive: false };
    const before = await renderHtml(original, props, 'Badge.svelte');
    const after = await renderHtml(shaken, props, 'Badge.svelte');
    expect(after).toBe(before);
    expect(before).toContain('off'); // the taken arm rendered
    expect(before).not.toContain('>on<'); // the dead arm never showed
  });

  it('fold-nested: a folded prop referenced inside the taken ternary arm is substituted, not dangled', async () => {
    // `flag` folds true -> `{flag ? text : 'none'}` collapses to its taken arm,
    // which is `text` — itself a folded prop dropped from the signature. The arm
    // is re-emitted verbatim, so the engine must substitute `text` INTO that
    // emitted text or it would become a dangling reference (`text is not
    // defined`) at runtime. This guards that substitution.
    const dir = join(FIXTURES, 'fold-nested');
    const entry = join(dir, 'input', 'App.svelte');

    const { plans } = await analyze(entry, fsResolve, readFile);
    const plan = plans.get(join(dir, 'input', 'Label.svelte'))!;
    expect(plan.constFold.get('flag')).toBe(true);
    expect(plan.constFold.get('text')).toBe('hi');

    const out = await svelteShaker(entry, fsResolve, readFile);
    const shaken = out[join(dir, 'input', 'Label.svelte')]!;
    // The taken arm folded AND its inner folded-prop ref was substituted.
    expect(shaken).toContain('{"hi"}');
    expect(shaken).not.toContain('? text'); // ternary gone
    expect(shaken).not.toMatch(/\btext\b/); // no dangling identifier left
    expect(shaken).not.toMatch(/let \{ /); // both props dropped -> empty signature

    // Soundness: the shaken component takes NO props, yet renders identically to
    // the original under the props that actually occur (flag=true, text='hi').
    const original = readFileSync(join(dir, 'input', 'Label.svelte'), 'utf-8');
    const before = await renderHtml(
      original,
      { flag: true, text: 'hi' },
      'Label.svelte',
    );
    const after = await renderHtml(shaken, {}, 'Label.svelte');
    expect(after).toBe(before);
    expect(before).toContain('hi');
    expect(before).not.toContain('none'); // the dead arm never rendered
  });

  it('if-true: an always-true {#if} is unwrapped and an empty false {#if} is removed', async () => {
    const dir = join(FIXTURES, 'if-true');
    const entry = join(dir, 'input', 'App.svelte');

    const { plans } = await analyze(entry, fsResolve, readFile);
    const plan = plans.get(join(dir, 'input', 'Panel.svelte'))!;
    expect(plan.constFold.get('show')).toBe(true);
    expect(plan.constFold.get('pad')).toBe(false);

    const out = await svelteShaker(entry, fsResolve, readFile);
    const shaken = out[join(dir, 'input', 'Panel.svelte')]!;

    // (3) Always-true -> the consequent is unwrapped (markers + `{:else}` gone),
    //     and the empty false `{#if pad}{/if}` is removed entirely.
    expect(shaken).not.toMatch(/\{#if\b/);
    expect(shaken).not.toContain('{:else}');
    expect(shaken).toContain('<p>always shown</p>');
    expect(shaken).not.toContain('never shown'); // the dead else arm is gone
    expect(shaken).toContain('<p>panel base</p>');

    // Soundness: for the values that actually occur the HTML is unchanged.
    const original = readFileSync(join(dir, 'input', 'Panel.svelte'), 'utf-8');
    const props = { show: true, pad: false };
    const before = await renderHtml(original, props, 'Panel.svelte');
    const after = await renderHtml(shaken, props, 'Panel.svelte');
    expect(after).toBe(before);
    expect(before).toContain('always shown');
    expect(before).not.toContain('never shown');
  });

  it("cascade (fixpoint): folding Mid's dead branch removes Heavy's only call site", async () => {
    // App -> Mid -> Heavy. `<Mid show={false}/>` folds Mid's `{#if show}` block,
    // which CONTAINS `<Heavy label="x"/>`. Without the fixpoint, that call site
    // would still count and Heavy's `label` would fold to "x". With it, the dead
    // site is excluded, so Heavy has ZERO live call sites and is left untouched.
    const dir = join(FIXTURES, 'cascade');
    const entry = join(dir, 'input', 'App.svelte');

    const { plans } = await analyze(entry, fsResolve, readFile);
    const midPlan = plans.get(join(dir, 'input', 'Mid.svelte'))!;
    const heavyPlan = plans.get(join(dir, 'input', 'Heavy.svelte'))!;

    // Mid still folds `show` -> false (its sole driver is `<Mid show={false}/>`).
    expect(midPlan.constFold.get('show')).toBe(false);
    // The cascade: Heavy's only call site lived in Mid's now-dead branch, so it
    // is excluded from the profile. Heavy has no live call site -> nothing folds,
    // and the engine handles the zero-call-site child gracefully (no crash, no
    // bail). `label` stays a genuine, untouched prop.
    expect(heavyPlan.bail).toBe(false);
    expect(heavyPlan.constFold.has('label')).toBe(false);
    expect(heavyPlan.narrow.has('label')).toBe(false);

    const out = await svelteShaker(entry, fsResolve, readFile);
    const mid = out[join(dir, 'input', 'Mid.svelte')]!;
    const heavy = out[join(dir, 'input', 'Heavy.svelte')]!;

    // Mid's output has no `<Heavy>` usage and no `{#if show}` block.
    expect(mid).not.toContain('<Heavy');
    expect(mid).not.toMatch(/\{#if show\}/);
    expect(mid).toContain('<p>mid</p>');
    // Heavy is left untouched: `label` is still destructured and rendered.
    expect(heavy).toMatch(/let \{ label \}/);
    expect(heavy).toContain('<p>{label}</p>');

    // Soundness: Mid's observable HTML for the value that actually occurs
    // (show=false) is identical before and after shaking. Both versions still
    // statically import Heavy, so we render through the small-graph oracle that
    // resolves the child.
    const originalMid = readFileSync(join(dir, 'input', 'Mid.svelte'), 'utf-8');
    const heavySrc = readFileSync(join(dir, 'input', 'Heavy.svelte'), 'utf-8');
    const deps = { './Heavy.svelte': heavySrc };
    const before = await renderGraphHtml(
      { specifier: './Mid.svelte', source: originalMid },
      deps,
      { show: false },
    );
    const after = await renderGraphHtml(
      { specifier: './Mid.svelte', source: mid },
      deps,
      { show: false },
    );
    expect(after).toBe(before);
    expect(before).toContain('mid');
    expect(before).not.toContain('<p>x</p>'); // the dead branch never rendered
  });
});
