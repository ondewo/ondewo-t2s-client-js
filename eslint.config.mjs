import typescriptEslint from '@typescript-eslint/eslint-plugin';
import globals from 'globals';
import tsParser from '@typescript-eslint/parser';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import js from '@eslint/js';
import { FlatCompat } from '@eslint/eslintrc';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const compat = new FlatCompat({
	baseDirectory: __dirname,
	recommendedConfig: js.configs.recommended,
	allConfig: js.configs.all
});

export default [
	{
		ignores: ['**/api/', 'src/ondewo-nlu-api', '**/ondewo-proto-compiler', '**/*.mjs']
	},
	...compat.extends(
		'plugin:@typescript-eslint/recommended',
		'plugin:@typescript-eslint/recommended-requiring-type-checking'
	),
	{
		plugins: {
			'@typescript-eslint': typescriptEslint
		},

		languageOptions: {
			globals: {
				...globals.browser
			},

			parser: tsParser,
			ecmaVersion: 12,
			sourceType: 'module',

			parserOptions: {
				project: 'tsconfig.json'
			}
		},

		rules: {
			'@typescript-eslint/explicit-member-accessibility': [
				'error',
				{
					accessibility: 'explicit',

					overrides: {
						accessors: 'explicit',
						parameterProperties: 'explicit'
					}
				}
			],

			'@typescript-eslint/no-inferrable-types': ['off'],

			'@typescript-eslint/array-type': [
				'error',
				{
					default: 'array'
				}
			],

			'@typescript-eslint/unbound-method': [
				'warn',
				{
					ignoreStatic: true
				}
			],

			'@typescript-eslint/no-unsafe-member-access': ['warn'],
			'@typescript-eslint/no-this-alias': ['warn'],

			'@typescript-eslint/no-misused-promises': [
				'error',
				{
					checksVoidReturn: false
				}
			],

			'@typescript-eslint/no-unsafe-call': ['off'],
			'@typescript-eslint/no-unused-vars': ['off'],
			'no-whitespace-before-property': ['error'],
			'no-trailing-spaces': ['error'],

			'@typescript-eslint/no-shadow': [
				'error',
				{
					hoist: 'all'
				}
			],

			'@typescript-eslint/no-misused-new': 'error',
			'@typescript-eslint/no-floating-promises': 'error',

			eqeqeq: ['error', 'always'],
			semi: ['error', 'always'],

			'id-denylist': ['error', 'err', 'any', 'cb', 'callback', 'i1', 'test', 'collection', 'list'],

			'no-multiple-empty-lines': ['error'],
			'no-new-wrappers': ['error'],
			'prefer-const': ['error'],
			'no-var': ['error'],
			'no-multi-spaces': 'error',
			'block-spacing': ['error', 'always'],

			'brace-style': [
				'error',
				'1tbs',
				{
					allowSingleLine: true
				}
			],

			'comma-spacing': [
				'error',
				{
					before: false,
					after: true
				}
			],

			'semi-spacing': [
				'error',
				{
					before: false,
					after: true
				}
			],

			'space-in-parens': ['error', 'never'],
			'space-before-blocks': ['error', 'always'],
			'no-return-assign': 'error',
			'no-mixed-operators': 'warn',
			'no-nested-ternary': 'error',
			'no-unneeded-ternary': 'error',
			'prefer-exponentiation-operator': 'error',

			'arrow-spacing': [
				'error',
				{
					before: true,
					after: true
				}
			],

			'func-call-spacing': ['error', 'never'],

			'key-spacing': [
				'error',
				{
					afterColon: true
				}
			],

			'@typescript-eslint/explicit-function-return-type': ['error'],

			'@typescript-eslint/typedef': [
				'error',
				{
					arrowParameter: true,
					memberVariableDeclaration: true,
					variableDeclaration: true,
					parameter: true,
					propertyDeclaration: true
				}
			],

			'@typescript-eslint/consistent-type-definitions': ['error', 'interface'],

			'@typescript-eslint/no-confusing-void-expression': [
				'error',
				{
					ignoreArrowShorthand: true
				}
			],

			'@typescript-eslint/prefer-reduce-type-parameter': ['error'],
			'default-param-last': 'off',
			'@typescript-eslint/default-param-last': ['error'],
			'no-redeclare': 'off',
			'@typescript-eslint/no-redeclare': ['error'],
			'@typescript-eslint/prefer-readonly-parameter-types': ['off'],
			'guard-for-in': ['warn'],
			'@typescript-eslint/no-unused-vars-experimental': ['off'],
			'@typescript-eslint/no-explicit-any': ['warn'],
			'@typescript-eslint/no-unsafe-assignment': ['warn'],
			'@typescript-eslint/no-unsafe-return': ['error'],

			'@typescript-eslint/explicit-module-boundary-types': [
				'error',
				{
					allowArgumentsExplicitlyTypedAsAny: true
				}
			],

			'no-ternary': 'warn',
			'@typescript-eslint/member-ordering': ['off']
		}
	},
	{
		files: ['**/*.spec.ts'],
		ignores: ['**/node_modules/**'],

		rules: {
			'@typescript-eslint/no-floating-promises': 'off'
		}
	}
];
