module.exports = {
    preset: 'ts-jest',
    testEnvironment: 'node',
    testMatch: ['**/tests/**/*.test.ts'],
    clearMocks: true,
    restoreMocks: true,
    setupFiles: ['<rootDir>/tests/setup.cjs'],
    collectCoverage: true,
    collectCoverageFrom: ['src/**/*.ts'],
    coverageDirectory: 'coverage',
    coverageThreshold: { global: { branches: 90, functions: 100, lines: 95, statements: 95 } },
};
