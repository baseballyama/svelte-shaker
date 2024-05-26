// Tree shaking for Svelte components

import { rollup } from 'rollup';
import virtual from '@rollup/plugin-virtual';

const phase2 = async (jsCode: string) => {
  const bundle = await rollup({
    input: 'entry',
    plugins: [
      virtual({
        entry: jsCode,
      }),
    ],
    treeshake: true,
  });

  const output = await bundle.generate({
    format: 'es',
  });

  return output.output[0].code;
};

export { phase2 };
