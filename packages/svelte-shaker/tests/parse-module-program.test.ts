import { describe, expect, it } from 'vitest';
import { parseModuleProgram, walk, type AnyNode } from '../src/parse';

// ----------------------------------------------------------------------
// `parseModuleProgram` is the single parse both non-`.svelte` module readers
// share — the escape scan (`moduleImportSpecifiers`) and barrel-following
// (`parseModuleBody`).  It neutralizes any `</script>` in the text so a valid
// module that merely mentions it still parses (issue #146).  These tests pin the
// two edges of that neutralization: a specifier that ITSELF carried `</script`
// must degrade loudly (return `null`), and the deliberately case-insensitive
// neutralization must not break a module that mentions `</SCRIPT>`.
// ----------------------------------------------------------------------

/** Every static import/export/dynamic-`import()` source literal in `program`. */
function specifiers(program: AnyNode): string[] {
  const out: string[] = [];
  const push = (source: AnyNode | undefined): void => {
    if (source?.type === 'Literal' && typeof source.value === 'string') out.push(source.value);
  };
  walk<null>(program, null, {
    ImportDeclaration: (n, { next }) => (push(n.source), next()),
    ExportNamedDeclaration: (n, { next }) => (push(n.source), next()),
    ExportAllDeclaration: (n, { next }) => (push(n.source), next()),
    ImportExpression: (n, { next }) => (push(n.source), next()),
  });
  return out;
}

describe('parseModuleProgram — `</script>` in module text (issue #146)', () => {
  it('parses a module that mentions `</script>` in a comment, string, and regex', () => {
    const program = parseModuleProgram(
      `// turn </script> into an entity
export function sanitize(s) {
  return s.replaceAll('</script>', '&lt;/script&gt;').replace(/<\\/script\\s*>/gi, '');
}
export { default as C } from './C.svelte';`,
      'sanitizer.ts',
    );
    expect(program).not.toBeNull();
    expect(specifiers(program!)).toEqual(['./C.svelte']);
  });

  it('still returns null for a genuinely broken module', () => {
    expect(parseModuleProgram('export const = ;', 'broken.ts')).toBeNull();
  });
});

describe('parseModuleProgram — a specifier that itself contains `</script` degrades loudly', () => {
  // The neutralization rewrites `</script` in the RAW text, which would silently
  // corrupt a specifier that contains it (`'./a</script>b.svelte'` -> a path that
  // no longer resolves).  Rather than resolve a rewritten lie, the whole module is
  // failed (null) — the same loud degrade a parse error gives, so the escape scan
  // reports it `unscannable` and barrel-following leaves it unfollowed.
  it('fails a static `import` whose specifier carries `</script`', () => {
    expect(parseModuleProgram(`import x from './a</script>b.svelte';\n`, 'm.ts')).toBeNull();
  });

  it('fails an `export … from` whose specifier carries `</script`', () => {
    expect(
      parseModuleProgram(`export { default as C } from './a</script>b.svelte';\n`, 'm.ts'),
    ).toBeNull();
  });

  it('fails a dynamic `import()` whose literal specifier carries `</script`', () => {
    expect(
      parseModuleProgram(`export const p = import('./a</script>b.svelte');\n`, 'm.ts'),
    ).toBeNull();
  });
});

describe('parseModuleProgram — neutralization is case-insensitive on purpose', () => {
  // Svelte only closes the wrapper on a lowercase `</script`, but we neutralize
  // any case so the transform never depends on the parser's exact casing rule.
  // A module mentioning `</SCRIPT>` must therefore still scan normally — its
  // specifier does not carry the sequence, so nothing degrades.
  it('scans a module that mentions `</SCRIPT>` in a comment', () => {
    const program = parseModuleProgram(
      `// mentions </SCRIPT> in uppercase
import U from './Upper.svelte';
export const u = U;`,
      'upper.ts',
    );
    expect(program).not.toBeNull();
    expect(specifiers(program!)).toEqual(['./Upper.svelte']);
  });
});
