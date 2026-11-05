import tsParser from '@typescript-eslint/parser';

const loadingRestrictions = [
  { selector: "ImportExpression[source.type!='Literal']",
    message: 'Authorial dynamic imports must use a string literal visible to dependency-cruiser.' },
  { selector: "Identifier[name=/^(require|createRequire|getBuiltinModule|eval|Function)$/]",
    message: 'Use statically analyzable ESM imports; opaque loaders cannot bypass architecture.' },
  { selector: "ImportSpecifier[imported.name='createRequire']",
    message: 'Use statically analyzable ESM imports, not an alias for a runtime loader.' },
];

export default [
  { ignores: ['node_modules/**', 'dist/**', '.git/**', '.worktrees/**', '.scratch/**'] },
  {
    files: ['**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}'],
    languageOptions: { parser: tsParser, ecmaVersion: 'latest', sourceType: 'module' },
    rules: { 'no-restricted-syntax': ['error', ...loadingRestrictions] },
  },
  {
    files: ['src/control/rules/**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}'],
    rules: {
      'no-restricted-syntax': ['error', ...loadingRestrictions,
        { selector: "Identifier[name=/^(Date|performance|process|global|globalThis|setTimeout|setInterval|setImmediate)$/]",
          message: 'Pure Control rules use injected data/time, not ambient clocks or I/O.' },
        { selector: "MemberExpression[object.name='Math'][property.name='random']",
          message: 'Pure Control rules use injected data, not ambient randomness.' },
      ],
    },
  },
];
