import { defineConfig } from 'vitest/config';
export default defineConfig({
    test: {
        env: { DYNAMODB_ENDPOINT: process.env.DYNAMODB_ENDPOINT ?? 'http://127.0.0.1:18000' },
        globals: true,
        restoreMocks: true,
        clearMocks: true,
        include: ['tests/integration/*.test.ts'],
        setupFiles: ['tests/setup.cjs'],
        testTimeout: 30000,
        hookTimeout: 60000,
        fileParallelism: false,
    },
});
