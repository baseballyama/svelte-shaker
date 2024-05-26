// JavaScript to Svelte component

import MagicString from 'magic-string';
import { parse, type NodeWithComment } from './acorn';
import { walk } from 'zimmerframe';

const replace = (
  code: string,
  landmark: string,
  svelteCode: string,
): string => {
  const startPattern = `__SvelteShaker__("@@__${landmark}__START__@@");`;
  const endPattern = `__SvelteShaker__("@@__${landmark}__END__@@");`;
  const startEndPattern = `__SvelteShaker__("@@__${landmark}__START_END__@@");`;

  const start = code.indexOf(startPattern);
  if (start !== -1) {
    const end = code.indexOf(endPattern);
    if (end !== -1) {
      console.log({
        a: start + startPattern.length,
        b: end,
      });
      if (start + startPattern.length + 1 === end) {
        return code.replace(code.substring(start, end + endPattern.length), '');
      }
      return code.replace(
        code.substring(start, end + endPattern.length),
        svelteCode,
      );
    }

    // hrow new Error('End not found');
  }
  const startEnd = code.indexOf(startEndPattern);
  if (startEnd !== -1) {
    return code.replace(
      code.substring(startEnd, startEnd + startEndPattern.length),
      svelteCode,
    );
  }
  // throw new Error('Start not found');
  return code;
};

const phase3 = async (jsCode: string) => {
  // let code = jsCode;
  // for (const landmark of Object.keys(nodeMap)) {
  //   const svelteCode = nodeMap[landmark] ?? '';
  //   code = replace(code, landmark, svelteCode);
  // }

  // return code;

  const ast: any = parse(jsCode);

  const magicString = new MagicString(jsCode);

  const props = {
    start: 0,
    content: '',
  };
  walk(ast, { parent: undefined } as { parent: NodeWithComment | undefined }, {
    _(node, { next, state }) {
      const { leadingComments } = node;

      if (node.type === 'CallExpression') {
        const { callee } = node;
        if (callee.name === '__svelte_shaker_props_start__') {
          props.start = callee.start;
          props.content = node.arguments[0].value;
        } else if (callee.name === '__svelte_shaker_props_end__') {
          magicString.overwrite(props.start, node.end + 1, props.content);
        } else if (callee.name === '__svelte_shaker_dummy__') {
          magicString.overwrite(
            node.start,
            node.end + 1,
            node.arguments[1].value,
          );
        }
      }

      const regexp = /^\s*@@(\d+)@@__([\s\S]*)__@@\s*$/m;
      if (leadingComments) {
        for (const block of leadingComments ?? []) {
          const { value } = block;
          const [, , content = ''] = regexp.exec(value) || [];
          const { start = -1, end = -1 } = state.parent ?? {};
          if (content) {
            magicString.overwrite(start, end, content);
            break;
          }
        }
      }
      next({ ...state, parent: node });
    },
  });

  return magicString.toString();
};

export { phase3 };
