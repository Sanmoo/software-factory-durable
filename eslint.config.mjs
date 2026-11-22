import tsParser from '@typescript-eslint/parser';
import tseslint from 'typescript-eslint';

const loadingRestrictions = [
  { selector: "ImportExpression[source.type!='Literal']",
    message: 'Authorial dynamic imports must use a string literal visible to dependency-cruiser.' },
  { selector: "Identifier[name=/^(require|createRequire|getBuiltinModule|eval|Function)$/]",
    message: 'Use statically analyzable ESM imports; opaque loaders cannot bypass architecture.' },
  { selector: "ImportSpecifier[imported.name='createRequire']",
    message: 'Use statically analyzable ESM imports, not an alias for a runtime loader.' },
];

const privateSdkAlias = { selector: ":matches(ImportDeclaration,ExportNamedDeclaration,ExportAllDeclaration,ImportExpression)[source.value='#factory-pi']",
  message: 'The private SDK alias is confined to Workers, like the upstream SDK.' };
// v2 (V2-03): Control decides by the capabilities the sandbox declares; it never names an adapter or its service (comments are not code).
const sandboxNames = '/gondolin|lambda|microvm|qemu/i';
const capabilitiesOnly = [`Identifier[name=${sandboxNames}]`, `Literal[value=${sandboxNames}]`, `TemplateElement[value.raw=${sandboxNames}]`].map(selector => ({ selector,
  message: 'Control reads the declared capabilities of the sandbox, never the name of an adapter or a detail of its service.' }));

export default [
  { ignores: ['node_modules/**', 'dist/**', '.git/**', '.worktrees/**', '.scratch/**'] },
  // The ecosystem's rule set (adopted in S2 of ADOPTION-PLAN.md); the architecture rules below stay as they were.
  ...tseslint.configs.recommended.map(config => ({ ...config, files: ['**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}'] })),
  {
    files: ['**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}'],
    rules: {
      // The project's convention: a leading underscore marks a binding kept on purpose (a field dropped from a rest destructure,
      // a callback parameter the signature requires).
      '@typescript-eslint/no-unused-vars': ['error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_', destructuredArrayIgnorePattern: '^_', ignoreRestSiblings: true }],
    },
  },
  {
    files: ['**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}'],
    languageOptions: { parser: tsParser, ecmaVersion: 'latest', sourceType: 'module' },
    rules: { 'no-restricted-syntax': ['error', ...loadingRestrictions] },
  },
  {
    files: ['src/**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}'],
    ignores: ['src/workers/**'],
    rules: { 'no-restricted-syntax': ['error', ...loadingRestrictions, privateSdkAlias] },
  },
  {
    files: ['src/control/**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}'],
    rules: { 'no-restricted-syntax': ['error', ...loadingRestrictions, privateSdkAlias, ...capabilitiesOnly] },
  },
  {
    files: ['src/control/rules/**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}'],
    rules: {
      'no-restricted-syntax': ['error', ...loadingRestrictions, privateSdkAlias, ...capabilitiesOnly,
        { selector: "Identifier[name=/^(Date|performance|process|global|globalThis|setTimeout|setInterval|setImmediate)$/]",
          message: 'Pure Control rules use injected data/time, not ambient clocks or I/O.' },
        { selector: "MemberExpression[object.name='Math'][property.name='random']",
          message: 'Pure Control rules use injected data, not ambient randomness.' },
      ],
    },
  },
];
