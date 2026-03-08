import { eslintConfigs } from '@aligent/ts-code-standards';

export default [
    ...eslintConfigs.base,
    {
        ignores: [
            '**/*.js',
            '**/*.mjs',
            'dist/',
            'node_modules/',
            '.yarn/',
            'coverage/',
            'oclif.manifest.json',
        ],
    },
    {
        files: ['**/*.ts'],
        languageOptions: {
            parserOptions: {
                project: ['./tsconfig.json', './tsconfig.test.json'],
            },
        },
    },
];
