// Convert Svelte files to js file.

import MagicString from 'magic-string';
import { walk } from 'zimmerframe';
import { parse } from 'svelte/compiler';

const escapeString = (str: string) => {
  return str.replaceAll('"', '\\"').replaceAll('\n', '\\n');
};

const unescapeString = (str: string) => {
  return str.replaceAll('\\"', '"').replaceAll('\\n', '\n');
};

const buildComment = (position: number, str: string) => {
  return `/* @@${position}@@__${escapeComment(str)}__@@ */`;
};

const buildPropsDummyCode = (str: string) => {
  const start = `__svelte_shaker_props_start__("${escapeString(str)}");`;
  const end = '__svelte_shaker_props_end__();';
  return { start, end };
};

const buildDummyCode = (position: number, str: string) => {
  return `__svelte_shaker_dummy__(${position}, "${escapeString(str)}");`;
};

const escapeComment = (str: string) => {
  return str.replace(/\*(\/+)/g, '*\\$1');
};

const unescapeComment = (str: string) => {
  return str.replace(/\*\\(\/+)/g, '*$1');
};

const phase1 = (svelteCode: string, props: Record<string, any>): string => {
  const handleScript = (node: any | undefined) => {
    if (node == null) return;
    const { start, end } = node;
    const { start: contentStart, end: contentEnd } = node.content;
    const startDummy = buildDummyCode(
      start,
      svelteCode.substring(start, contentStart),
    );
    const endDummy = buildDummyCode(
      contentEnd,
      svelteCode.substring(contentEnd, end),
    );

    magicString.overwrite(start, contentStart, startDummy);
    magicString.overwrite(contentEnd, end, endDummy);

    walk(
      node,
      {},
      {
        VariableDeclaration(node) {
          const { declarations } = node;
          for (const declaration of declarations) {
            const { init, id } = declaration;
            if (
              init == null ||
              id == null ||
              init.type !== 'CallExpression' ||
              id.type !== 'ObjectPattern'
            ) {
              return;
            }
            const { callee } = init;
            if (callee == null || callee.type !== 'Identifier') {
              return;
            }
            if (callee.name !== '$props') {
              return;
            }

            const { start: dummyStart, end: dummyEnd } = buildPropsDummyCode(
              svelteCode.substring(node.start, node.end),
            );

            let propsCode = dummyStart;
            const { properties } = id;
            for (const property of properties) {
              const { start, end } = property;
              if (property.type === 'Property') {
                const { key } = property;
                if (key.type === 'Identifier') {
                  const { name } = key;
                  if (props[name] !== undefined) {
                    propsCode += `let ${name} = ${JSON.stringify(props[name])};`;
                    continue;
                  }
                }
              }
              const name = svelteCode.substring(start, end);
              propsCode += `let ${name} = __svelte_shaker_props__();`;
            }
            propsCode += dummyEnd;
            magicString.overwrite(node.start, node.end, propsCode);
          }
        },
      },
    );
  };

  const handleHtml = (node: any | undefined) => {
    if (node == null) return;

    walk(
      node,
      { identifiers: [] as string[] },
      {
        // _(node, { next, state }) {
        //   next(state);
        // },
        Identifier(node, { next, state }) {
          const name = node.name as string;
          state.identifiers.push(name);
          next(state);
        },
        IfBlock(node, { next, state }) {
          next(state);
          const { start, end, children } = node;
          const { start: exprStart, end: exprEnd } = node.expression;
          const childrenEnd = children[children.length - 1].end;
          const expressionString = svelteCode.substring(exprStart, exprEnd);

          const ifStartBlock = svelteCode.substring(start, exprEnd + 1);
          const ifEndBlock = svelteCode.substring(childrenEnd + 1, end);
          const startBlock = `{${buildComment(start, ifStartBlock)}if (${expressionString}) {`;
          const endBlock = `}${buildComment(childrenEnd + 1, ifEndBlock)}}`;
          magicString.overwrite(start, exprEnd + 1, startBlock);
          magicString.overwrite(childrenEnd, end, endBlock);
        },
        Element(node, { next, state }) {
          next(state);
          const { start, end } = node;
          const elementString = svelteCode.substring(start, end + 1);
          const startBlock = `{${buildComment(start, elementString)}`;
          const content = `console.log(${state.identifiers.join(', ')});`;
          const endBlock = '}';
          magicString.overwrite(
            start,
            end,
            `${startBlock}${content}${endBlock}`,
          );
          state.identifiers = [];
        },
      },
    );
  };

  const handleStyle = (node: any | undefined) => {
    if (node == null) return;
    const { start, end } = node;
    const styleString = svelteCode.substring(start, end + 1);

    magicString.overwrite(start, end, buildDummyCode(start, styleString));
  };

  // ----------------------------------------------------------------------
  // ^^^^^ Internal Functions ^^^^^
  // ----------------------------------------------------------------------

  const magicString = new MagicString(svelteCode);
  const parsed = parse(svelteCode);

  handleScript(parsed.module);
  handleScript(parsed.instance);
  handleHtml(parsed.html);
  handleStyle(parsed.css);

  return magicString.toString();
};

export { phase1 };
