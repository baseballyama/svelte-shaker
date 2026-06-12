import { afterAll, describe, expect, it } from 'vitest';
import { cleanTmp, renderHtml, renderHtmlRaw } from './diff';

// ----------------------------------------------------------------------
// Whitespace oracle: the engine deletes/collapses `{#if}` chains and must not
// change the RENDERED whitespace (tests/diff.ts `normalizeHtml` collapses runs
// but distinguishes presence vs absence of a space).  That soundness argument
// rests on an empirically-derived Svelte 5 rule:
//
//   Per fragment, a whitespace-only text node is trimmed at a fragment EDGE and
//   collapsed to a single space BETWEEN two rendering nodes (element / text /
//   expression tag / block — a comment is transparent and counts as an edge).
//   Inside `<pre>`/`<textarea>` (and under `preserveWhitespace`) nothing is
//   trimmed.
//
// These tests render each template with the INSTALLED svelte so the rule — and
// the `{" "}` compensation / kept-arm strip the transform relies on — is
// re-verified on every run, guarding against an upstream svelte change.
// ----------------------------------------------------------------------

const W = '\n  '; // a representative whitespace-only run (newline + indent)
const norm = (source: string) => renderHtml(source, {}, 'Ws.svelte');

afterAll(() => cleanTmp());

describe('whitespace oracle / Svelte 5 trimming rule', () => {
  // [name, template, normalized expected body]
  const cases: Array<[string, string, string]> = [
    // Plain elements: edge runs trimmed, inner run kept.
    [
      'edges trimmed, inner kept',
      `<div>${W}<p>a</p>${W}<p>b</p>${W}</div>`,
      '<div><p>a</p> <p>b</p></div>',
    ],
    // A dead `{#if}` is a rendering block: leading run trims, the run between it
    // and `<p>` is kept (this exact seam is the #37 bug after naive deletion).
    [
      'block keeps the inner run',
      `<div>${W}{#if false}<b>x</b>{/if}${W}<p>b</p></div>`,
      '<div> <p>b</p></div>',
    ],
    [
      'trailing run after a block is kept',
      `<div><p>a</p>${W}{#if false}<b>x</b>{/if}${W}</div>`,
      '<div><p>a</p> </div>',
    ],
    [
      'block-only fragment trims both edges',
      `<div>${W}{#if false}<b>x</b>{/if}${W}</div>`,
      '<div></div>',
    ],
    [
      'runs on both sides of a block',
      `<div><p>a</p>${W}{#if false}<b>x</b>{/if}${W}<p>b</p></div>`,
      '<div><p>a</p> <p>b</p></div>',
    ],
    [
      'leading block, no leading run',
      `<div>{#if false}<b>x</b>{/if}${W}<p>b</p></div>`,
      '<div> <p>b</p></div>',
    ],
    // A comment is transparent: the run on its side trims as if at an edge.
    [
      'comment counts as an edge',
      `<div><!--c-->${W}{#if false}<b>x</b>{/if}${W}<p>b</p></div>`,
      '<div> <p>b</p></div>',
    ],
    // Kind of neighbour does not matter — expression tags keep the run too.
    [
      'expression-tag neighbours',
      `<div>{'L'}${W}{#if false}<b>x</b>{/if}${W}{'R'}</div>`,
      '<div>L R</div>',
    ],
    // The same rule holds inside other fragment kinds.
    [
      'each body',
      `{#each [1] as n}<div>${W}{#if false}<b>x</b>{/if}${W}<p>{n}</p></div>{/each}`,
      '<div> <p>1</p></div>',
    ],
    [
      'svelte:element body',
      `<svelte:element this={'div'}>${W}{#if false}<b>x</b>{/if}${W}<p>b</p></svelte:element>`,
      '<div> <p>b</p></div>',
    ],
  ];

  for (const [name, template, expected] of cases) {
    it(name, async () => {
      expect(await norm(template)).toBe(expected);
    });
  }
});

describe('whitespace oracle / full-chain removal is sound only with compensation', () => {
  it('naive deletion LOSES the separating space (the bug)', async () => {
    const original = await norm(`<div>${W}{#if false}<b>x</b>{/if}${W}<p>b</p></div>`);
    const naive = await norm(`<div>${W}${W}<p>b</p></div>`);
    expect(original).toBe('<div> <p>b</p></div>');
    expect(naive).toBe('<div><p>b</p></div>'); // space gone — what plain deletion would do
  });

  it('`{" "}` compensation restores the space (the fix)', async () => {
    const original = await norm(`<div>${W}{#if false}<b>x</b>{/if}${W}<p>b</p></div>`);
    const compensated = await norm(`<div>{" "}<p>b</p></div>`);
    expect(compensated).toBe(original);
  });

  it('a trailing separating space is also lost then restored', async () => {
    const original = await norm(`<div><p>a</p>${W}{#if false}<b>x</b>{/if}${W}</div>`);
    expect(await norm(`<div><p>a</p>${W}${W}</div>`)).toBe('<div><p>a</p></div>'); // lost
    expect(await norm(`<div><p>a</p>{" "}</div>`)).toBe(original); // restored
  });

  it('no space to lose: plain deletion already matches (no compensation)', async () => {
    // Edge-only and inner-on-both-sides seams keep their presence under plain
    // deletion, so the engine leaves them alone (length is normalized away).
    expect(await norm(`<div>${W}${W}</div>`)).toBe(
      await norm(`<div>${W}{#if false}<b>x</b>{/if}${W}</div>`),
    );
    expect(await norm(`<div><p>a</p>${W}${W}<p>b</p></div>`)).toBe(
      await norm(`<div><p>a</p>${W}{#if false}<b>x</b>{/if}${W}<p>b</p></div>`),
    );
  });
});

describe('whitespace oracle / kept-arm collapse must strip the arm edges', () => {
  it('a verbatim splice GAINS a space; stripping matches the original', async () => {
    const original = await norm(`<div><p>a</p>{#if true} <b>x</b>{/if}</div>`);
    expect(original).toBe('<div><p>a</p><b>x</b></div>'); // arm-edge ws trimmed in the block
    const verbatim = await norm(`<div><p>a</p> <b>x</b></div>`);
    expect(verbatim).toBe('<div><p>a</p> <b>x</b></div>'); // splicing the run inline gains a space
    const stripped = await norm(`<div><p>a</p><b>x</b></div>`);
    expect(stripped).toBe(original);
  });
});

describe('whitespace oracle / preserved whitespace is byte-exact under plain deletion', () => {
  it('inside <pre>, deleting a dead block leaves rendering byte-identical', async () => {
    const original = await renderHtmlRaw(
      `<pre>${W}{#if false}<b>x</b>{/if}${W}<p>b</p></pre>`,
      {},
      'Pre.svelte',
    );
    const deleted = await renderHtmlRaw(`<pre>${W}${W}<p>b</p></pre>`, {}, 'Pre.svelte');
    expect(deleted).toBe(original); // never compensate here — runs are observable
  });
});
