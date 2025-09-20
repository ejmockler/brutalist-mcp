/**
 * Mock CLI responses for testing
 */
import { CLIAgentResponse } from '../../src/types/brutalist.js';

export const mockSuccessfulResponse: CLIAgentResponse = {
  agent: 'codex',
  success: true,
  output: 'Your code has severe SQL injection vulnerabilities in the authentication module. The user input is directly concatenated into database queries without any sanitization.',
  executionTime: 2400,
  command: 'codex exec --model gpt-5 --sandbox read-only',
  workingDirectory: '/test',
  exitCode: 0
};

export const mockFailedResponse: CLIAgentResponse = {
  agent: 'gemini',
  success: false,
  output: '',
  error: 'Command timed out after 30000ms',
  executionTime: 30000,
  command: 'gemini --model gemini-2.5-flash --yolo',
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
  exitCode: 0
};

export const mockGeminiResponse: CLIAgentResponse = {
  agent: 'gemini',
  success: true,
  output: 'Your dependency management is a security nightmare. You have 47 packages with known CVEs including critical RCE vulnerabilities.',
  executionTime: 3200,
  command: 'gemini --model gemini-2.5-flash --yolo',
  workingDirectory: '/test',
  exitCode: 0
};

export const mockMixedResponses: CLIAgentResponse[] = [
  mockSuccessfulResponse,
  mockFailedResponse,
  mockClaudeResponse
];

export const mockAllSuccessfulResponses: CLIAgentResponse[] = [
  mockSuccessfulResponse,
  mockClaudeResponse,
  mockGeminiResponse
];

export const mockPartialFailureResponses: CLIAgentResponse[] = [
  mockSuccessfulResponse,
  mockFailedResponse
];