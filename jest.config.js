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
  // Regression-prevention floors on the extracted module boundaries.
  // Numbers are calibrated from the fresh coverage/lcov.info baseline
  // (2026-04-18) at 2–5 percentage points below observed coverage, rounded
  // down to whole integers. Files near 100% are floored at 95 to tolerate
  // single-test churn. See .clou/milestones/quality-infrastructure/
  // decisions.md for the per-path rationale.
  //
  // Path keys use the directory-style form documented at
  // https://jestjs.io/docs/configuration#coveragethreshold-object — Jest
  // matches keys that look like directory paths against file paths whose
  // prefix matches, so "./src/debate/" guards every file under that directory.
  //
  // NO raw `global` threshold is set — a global default would either mask
  // regressions in the guarded paths (if loose) or fail the suite on files
  // outside the extracted boundaries (if tight). Scope is intentional.
  coverageThreshold: {
    './src/debate/': {
      branches: 80,
      functions: 80,
      lines: 92,
      statements: 92
    },
    './src/cli-adapters/': {
      branches: 82,
      functions: 80,
      lines: 92,
      statements: 92
    }
  },
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