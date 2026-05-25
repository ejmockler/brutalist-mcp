/**
 * Mock CLI responses for testing
 */
import { CLIAgentResponse } from '../../src/types/brutalist.js';

export const mockSuccessfulResponse: CLIAgentResponse = {
  agent: 'codex',
  success: true,
  output: 'Your code has severe SQL injection vulnerabilities in the authentication module. The user input is directly concatenated into database queries without any sanitization.',
  executionTime: 2400,
  command: 'codex exec --sandbox read-only --skip-git-repo-check',
  workingDirectory: '/test',
  exitCode: 0,
  // model intentionally absent — exercises the "default" header fallback
  // path on the Codex side, where BRUTALIST_CODEX_ALLOW_MODEL_OVERRIDE is
  // off by default and the adapter returns model: undefined.
};

export const mockFailedResponse: CLIAgentResponse = {
  agent: 'codex',
  success: false,
  output: '',
  error: 'Command timed out after 30000ms',
  executionTime: 30000,
  command: 'codex exec --sandbox read-only',
  workingDirectory: '/test',
  exitCode: 124
};

export const mockClaudeResponse: CLIAgentResponse = {
  agent: 'claude',
  success: true,
  output: 'This architecture will collapse under load. The single database instance will become a bottleneck at 1000 concurrent users.',
  executionTime: 1800,
  command: 'claude --print',
  workingDirectory: '/test',
  exitCode: 0,
  model: 'opus'
};

export const mockMixedResponses: CLIAgentResponse[] = [
  mockSuccessfulResponse,
  mockFailedResponse,
  mockClaudeResponse
];

export const mockAllSuccessfulResponses: CLIAgentResponse[] = [
  mockSuccessfulResponse,
  mockClaudeResponse
];

export const mockPartialFailureResponses: CLIAgentResponse[] = [
  mockSuccessfulResponse,
  mockFailedResponse
];
