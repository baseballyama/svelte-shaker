import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/.shaker-tmp*/**',
      '**/tests/fixtures/**/actual/**',
      'packages/site/**',
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
);
