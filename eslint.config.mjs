import js from '@eslint/js'; // Core ESLint configuration
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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
		ignores: ['**/api/', 'src/ondewo-t2s-api', '**/ondewo-proto-compiler']
	},
	{
		files: ['**/*.js'], // Target all JavaScript files
		languageOptions: {
			globals: {
				// Add any global variables you want to recognize
				window: true,
				document: true,
				console: true // Allow the use of console globally
			},
			ecmaVersion: 2020, // Set ECMAScript version
			sourceType: 'module' // If using ES modules
		},
		rules: {
			...js.configs.recommended.rules,
			'prefer-const': 'error',
			'no-trailing-spaces': ['error'],
			eqeqeq: ['error', 'always'],
			semi: ['error', 'always'],
			'id-denylist': ['error', 'err', 'any', 'cb', 'callback', 'i1', 'test', 'collection', 'list'],

			'no-multiple-empty-lines': ['error'],
			'no-new-wrappers': ['error'],
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
			'no-ternary': 'warn',
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
			]
		}
	}
];
