export interface BrutalistServerConfig {
  openRouterApiKey?: string;
  maxModelsPerRequest?: number;
}

export interface ModelResponse {
  model: string;
  persona: string;
  content: string;
  tokensUsed?: number;
  responseTime?: number;
}

export interface BrutalistResponse {
  success: boolean;
  responses: ModelResponse[];
  synthesis?: string;
  error?: string;
}

export interface RoastOptions {
  userInput: string;
  codeContext?: string;
  fileType?: string;
  projectContext?: string;
  maxModels?: number;
  models?: string[];  // User-specified models
}
