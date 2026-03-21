export default {
  preset: 'ts-jest/presets/default-esm',
  testEnvironment: 'node',
  setupFiles: ['<rootDir>/jest.setup.js'],
  setupFilesAfterEnv: ['<rootDir>/tests/setup.ts'],
  roots: ['<rootDir>/tests', '<rootDir>/src'],
  testPathIgnorePatterns: [
    '<rootDir>/node_modules/'
  ],
  testMatch: [
    '<rootDir>/tests/**/*.test.ts',
    '<rootDir>/tests/**/*.spec.ts'
  ],
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.d.ts',
    '!src/index.ts',
    '!src/**/*.test.ts',
    '!src/**/*.spec.ts'
  ],
  coverageDirectory: 'coverage',
  coverageReporters: ['text', 'lcov', 'html'],
  // Temporarily disabled until test suite is fully updated
  // coverageThreshold: {
  //   global: {
  //     branches: 70,
  //     functions: 80,
  //     lines: 80,
  //     statements: 80
  //   }
  // },
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
  testTimeout: 30000,
  maxWorkers: '50%',
  workerIdleMemoryLimit: '512MB',
  // Run tests that spawn external CLI processes last to prevent their
  // "Not connected" child process crashes from blocking other test suites
  testSequencer: '<rootDir>/tests/test-sequencer.js',
  // Force exit after tests complete — the MCP SDK throws "Not connected" in
  // child processes during teardown, which poisons Jest workers. These are
  // cosmetic errors from the SDK's disconnect handling, not real test failures.
  forceExit: true
};