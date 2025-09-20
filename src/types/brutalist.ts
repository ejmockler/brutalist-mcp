export interface BrutalistServerConfig {
  workingDirectory?: string;
  defaultTimeout?: number;
  enableSandbox?: boolean;
}

export interface CLIAgentResponse {
  agent: 'claude' | 'codex' | 'gemini';
  success: boolean;
  output: string;
  error?: string;
  executionTime: number;
  command?: string;
  systemPromptType?: string;
  workingDirectory?: string;
  exitCode?: number;
}

export interface BrutalistResponse {
  success: boolean;
  responses: CLIAgentResponse[];
  synthesis?: string;
  error?: string;
  analysisType?: string;
  targetPath?: string;
  executionSummary?: {
    totalCLIs: number;
    successfulCLIs: number;
    failedCLIs: number;
    totalExecutionTime: number;
    selectedCLI?: string;
    selectionMethod?: string;
  };
}

export interface RoastOptions {
  targetPath: string;
  analysisType: string;
  context?: string;
  workingDirectory?: string;
  enableSandbox?: boolean;
  agents?: ('claude' | 'codex' | 'gemini')[];
}

export interface ChildProcessError extends Error {
  code?: number;
  stdout?: string;
  stderr?: string;
}
