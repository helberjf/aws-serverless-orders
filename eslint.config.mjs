import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
    { ignores: ['node_modules/**', 'coverage/**', '.aws-sam/**'] },
    {
        files: ['**/*.ts', '**/*.mts'],
        extends: [js.configs.recommended, ...tseslint.configs.recommended, prettier],
    },
);
