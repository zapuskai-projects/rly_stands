import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

const sharedRules = {
  'max-lines': ['error', { max: 400 }],
  'no-console': 'error',
  'no-inline-comments': 'error',
  '@typescript-eslint/no-explicit-any': 'error',
  '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
};

export default tseslint.config(
  { ignores: ['dist/**', 'web-dist/**', 'node_modules/**'] },
  ...tseslint.configs.recommended,
  { files: ['src/**/*.ts'], rules: sharedRules },
  {
    files: ['web/src/**/*.{ts,tsx}', 'web/vite.config.ts'],
    plugins: { 'react-hooks': reactHooks },
    rules: { ...sharedRules, 'react-hooks/rules-of-hooks': 'error', 'react-hooks/exhaustive-deps': 'error' },
  },
);
