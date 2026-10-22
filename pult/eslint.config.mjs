import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**'] },
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.ts'],
    rules: {
      'max-lines': ['error', { max: 400 }],
      'no-console': 'error',
      'no-inline-comments': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  {
    files: ['src/testing/live/**/*.ts'],
    rules: { '@typescript-eslint/no-explicit-any': 'off' },
  },
);
