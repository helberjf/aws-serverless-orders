import { defineConfig } from 'vitest/config';
export default defineConfig({
    test: {
        globals: true,
        restoreMocks: true,
        clearMocks: true,
        include: ['tests/*.test.ts'],
        setupFiles: ['tests/setup.cjs'],
        coverage: {
            provider: 'v8',
            include: ['src/**/*.ts'],
            reporter: ['text', 'json-summary', 'lcov'],
            thresholds: { lines: 90, statements: 90, functions: 90, branches: 85 },
        },
    },
});
