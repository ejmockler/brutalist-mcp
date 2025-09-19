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
}

export interface BrutalistResponse {
  success: boolean;
  responses: CLIAgentResponse[];
  synthesis?: string;
  error?: string;
  analysisType?: string;
  targetPath?: string;
}

export interface RoastOptions {
  targetPath: string;
  analysisType: string;
  context?: string;
  workingDirectory?: string;
  enableSandbox?: boolean;
  agents?: ('claude' | 'codex' | 'gemini')[];
}
