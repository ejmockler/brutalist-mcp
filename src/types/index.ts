export interface GeminiModel {
  name: string;
  description: string;
  available: boolean;
}

export interface GeminiPromptOptions {
  model?: string;
  prompt: string;
  sandbox?: boolean;
  debug?: boolean;
  yolo?: boolean;
  approvalMode?: 'default' | 'auto_edit' | 'yolo';
  inputData?: string;
  cwd?: string;
}

export interface GeminiResponse {
  success: boolean;
  output?: string;
  error?: string;
  model?: string;
}

export interface GeminiServerConfig {
  defaultModel?: string;
  geminiPath?: string;
}