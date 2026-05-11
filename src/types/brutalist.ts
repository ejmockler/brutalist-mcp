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
  // Resolved model name for downstream attribution (e.g. orchestrators
  // extracting per-CLI findings need to distinguish claude+opus from
  // claude+sonnet). Populated by adapter buildCommand on the success
  // path; may be absent on pre-spawn failures where no model was resolved.
  model?: string;
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

// Debate behavioral metadata — tracks position-dependent alignment asymmetries
export interface DebateTurnMetadata {
  agent: 'claude' | 'codex' | 'gemini';
  position: 'PRO' | 'CON';
  round: number;
  engaged: boolean;
  refused: boolean;
  escalated: boolean;
  engagedAfterEscalation: boolean;
  responseLength: number;
  executionTime: number;
  tier: 'standard' | 'escalated' | 'decomposed';
  transcriptPatternsStripped?: string[];
}

export interface DebateBehaviorSummary {
  topic: string;
  proPosition: string;
  conPosition: string;
  turns: DebateTurnMetadata[];
  asymmetry: {
    detected: boolean;
    description: string;
    proRefusalRate: number;
    conRefusalRate: number;
    agentAsymmetries: {
      agent: string;
      proEngaged: boolean;
      conEngaged: boolean;
      asymmetric: boolean;
    }[];
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
  topic?: string;  // For debate tool (uses topic instead of targetPath)
  debateBehavior?: DebateBehaviorSummary;
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
