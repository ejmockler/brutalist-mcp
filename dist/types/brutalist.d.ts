export interface BrutalistServerConfig {
    workingDirectory?: string;
    defaultTimeout?: number;
    transport?: 'stdio' | 'http';
    httpPort?: number;
    corsOrigins?: string[];
    allowCORSWildcard?: boolean;
}
export interface CLIAgentResponse {
    agent: 'claude' | 'codex' | 'agy';
    success: boolean;
    output?: string;
    error?: string;
    executionTime: number;
    command?: string;
    systemPromptType?: string;
    workingDirectory?: string;
    exitCode?: number;
    model?: string;
}
export interface RoastOptions {
    targetPath: string;
    analysisType: string;
    context?: string;
    workingDirectory?: string;
    agents?: ('claude' | 'codex' | 'agy')[];
}
export interface ChildProcessError extends Error {
    code?: number;
    stdout?: string;
    stderr?: string;
}
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
export interface DebateTurnMetadata {
    agent: 'claude' | 'codex' | 'agy';
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
export interface BrutalistResponse {
    success: boolean;
    responses: CLIAgentResponse[];
    synthesis?: string;
    error?: string;
    analysisType?: string;
    targetPath?: string;
    topic?: string;
    debateBehavior?: DebateBehaviorSummary;
    executionSummary?: {
        totalCLIs: number;
        successfulCLIs: number;
        failedCLIs: number;
        totalExecutionTime: number;
        selectedCLI?: string;
        selectionMethod?: string;
    };
    pagination?: PaginationMetadata;
    fullResponseAvailable?: boolean;
}
//# sourceMappingURL=brutalist.d.ts.map