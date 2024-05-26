import * as acorn from 'acorn';
import { walk } from 'zimmerframe';

type CommentWithLocation = acorn.Comment & {
  start: number;
  end: number;
};

export type NodeWithComment = acorn.Node & {
  leadingComments?: CommentWithLocation[];
  trailingComments?: CommentWithLocation[];
};

export const parse = (source: string): acorn.Program => {
  const parser = acorn.Parser;
  const { onComment, add_comments } = get_comment_handlers(source);

  const ast = parser.parse(source, {
    onComment,
    sourceType: 'module',
    ecmaVersion: 'latest',
    locations: true,
  });

  add_comments(ast);

  return ast;
};

const get_comment_handlers = (source: string) => {
  const comments: CommentWithLocation[] = [];

  return {
    onComment: (block: boolean, value: string, start: number, end: number) => {
      if (block && /\n/.test(value)) {
        let a = start;
        while (a > 0 && source[a - 1] !== '\n') a -= 1;

        let b = a;
        while (/[ \t]/.test(source[b]!!)) b += 1;

        const indentation = source.slice(a, b);
        value = value.replace(new RegExp(`^${indentation}`, 'gm'), '');
      }

      comments.push({ type: block ? 'Block' : 'Line', value, start, end });
    },

    add_comments(ast: NodeWithComment) {
      if (comments.length === 0) return;

      walk(ast, null, {
        _(node, { next }) {
          let comment: CommentWithLocation | undefined;

          while (comments[0] && comments[0].start < node.start) {
            comment = comments.shift();
            (node.leadingComments ||= []).push(comment!!);
          }

          next();

          if (comments[0]) {
            const slice = source.slice(node.end, comments[0].start);

            if (/^[,) \t]*$/.test(slice)) {
              node.trailingComments = [comments.shift()!!];
            }
          }
        },
      });
    },
  };
};
