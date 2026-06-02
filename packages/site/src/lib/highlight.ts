import { createHighlighter, type Highlighter } from 'shiki';
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript';

// Dual-theme Svelte highlighting for the playground. The JS regex engine avoids
// shipping the oniguruma WASM, and the highlighter is created ONCE (lazily) and
// shared — after init, `codeToHtml` is synchronous, so the editor overlay repaints
// without lag while you type.
export const LIGHT = 'github-light';
export const DARK = 'github-dark';

let pending: Promise<Highlighter> | null = null;

export function getHighlighter(): Promise<Highlighter> {
  pending ??= createHighlighter({
    themes: [LIGHT, DARK],
    langs: ['svelte'],
    engine: createJavaScriptRegexEngine(),
  });
  return pending;
}

/** Highlight Svelte source to dual-theme HTML (a `<pre class="shiki">…`). The
 * `tabindex` shiki adds is stripped: this `<pre>` is an aria-hidden, decorative
 * overlay, so it must not be a keyboard tab stop. */
export function highlightSvelte(hl: Highlighter, code: string): string {
  return hl
    .codeToHtml(code, { lang: 'svelte', themes: { light: LIGHT, dark: DARK } })
    .replace(' tabindex="0"', '');
}
