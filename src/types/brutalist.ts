export interface BrutalistServerConfig {
  workingDirectory?: string;
  defaultTimeout?: number;
  transport?: 'stdio' | 'http';
  httpPort?: number;
  // CORS configuration for security
  corsOrigins?: string[]; // Allowed origins
  allowCORSWildcard?: boolean; // Explicit opt-in for wildcard (dev only)
}

export interface CLIAgentResponse {
  agent: 'claude' | 'codex' | 'gemini';
  success: boolean;
  output?: string;
  error?: string;
  executionTime: number;
  command?: string;
  systemPromptType?: string;
  workingDirectory?: string;
  exitCode?: number;
}

export interface RoastOptions {
  targetPath: string;
  analysisType: string;
  context?: string;
  workingDirectory?: string;
  agents?: ('claude' | 'codex' | 'gemini')[];
}

export interface ChildProcessError extends Error {
  code?: number;
  stdout?: string;
  stderr?: string;
}

// Pagination types following MCP spec and software engineering best practices
export interface PaginationParams {
  offset?: number;
  limit?: number;
  cursor?: string;
}

export interface PaginationMetadata {
  total: number;
  offset: number;
  limit: number;
  hasMore: boolean;
  nextCursor?: string;
  chunkIndex: number;
  totalChunks: number;
}

export interface PaginatedResponse<T = string> {
  data: T;
  pagination: PaginationMetadata;
  summary?: string;
}

export interface ResponseChunk {
  content: string;
  startOffset: number;
  endOffset: number;
  metadata: {
    isComplete: boolean;
    truncated: boolean;
    originalLength: number;
  };
}

// Enhanced BrutalistResponse with pagination support
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
  // Pagination support
  pagination?: PaginationMetadata;
  fullResponseAvailable?: boolean;
}
