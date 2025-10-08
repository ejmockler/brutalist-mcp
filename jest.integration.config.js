export default {
  preset: 'ts-jest/presets/default-esm',
  testEnvironment: 'node',
  setupFiles: ['<rootDir>/jest.setup.js'],
  setupFilesAfterEnv: [
    '<rootDir>/tests/setup.ts',
    '<rootDir>/tests/setup-integration.ts'
  ],
  roots: ['<rootDir>/tests/integration'],
  testMatch: [
    '<rootDir>/tests/integration/**/*.test.ts'
  ],
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.d.ts',
    '!src/index.ts',
    '!src/**/*.test.ts'
  ],
  coverageDirectory: 'coverage/integration',
  coverageReporters: ['text', 'lcov', 'html'],
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
    '^@/(.*)$': '<rootDir>/src/$1'
  },
  extensionsToTreatAsEsm: ['.ts'],
  transform: {
    '^.+\\.tsx?$': ['ts-jest', {
      useESM: true,
      tsconfig: {
        module: 'node20',
        target: 'ES2022',
        moduleResolution: 'Node16',
        allowSyntheticDefaultImports: true,
        esModuleInterop: true,
        resolveJsonModule: true
      }
    }]
  },
  // Integration tests need more time
  testTimeout: 60000,
  maxWorkers: 1, // Run integration tests serially to avoid port conflicts
  // Detect open handles to find leaks
  detectOpenHandles: true,
  // Force exit after tests complete (with warning)
  forceExit: false,
  // Fail on console.error by default
  silent: false,
  // More verbose output for debugging
  verbose: true
};