import { BrutalistResponse, PaginationParams } from '../types/brutalist.js';
/**
 * ResponseFormatter - Handles all response formatting logic
 * Extracted from BrutalistServer to follow Single Responsibility Principle
 */
export declare class ResponseFormatter {
    /**
     * Format tool response with optional pagination
     */
    formatToolResponse(result: BrutalistResponse, verbose?: boolean, paginationParams?: PaginationParams, contextId?: string, explicitPaginationRequested?: boolean): {
        content: {
            type: "text";
            text: string;
        }[];
    };
    /**
     * Format paginated response with metadata and navigation
     */
    formatPaginatedResponse(content: string, paginationParams: PaginationParams, result: BrutalistResponse, verbose: boolean, contextId?: string): {
        content: {
            type: "text";
            text: string;
        }[];
    };
    /**
     * Format error response with sanitized message
     */
    formatErrorResponse(error: unknown): {
        content: {
            type: "text";
            text: string;
        }[];
    };
    /**
     * Extract full content from analysis result for caching.
     *
     * `synthesis` is always populated by ToolHandler.executeBrutalistAnalysis
     * (tool-handler.ts:403), so the historical raw-response reconstruction
     * branch was unreachable. Removed as part of the per-CLI delimiter
     * hardening — synthesis itself now carries the canonical
     * BRUTALIST_CLI_BEGIN/END section markers.
     */
    extractFullContent(result: BrutalistResponse): string | null;
    private formatNoContentError;
    private buildPaginatedHeader;
    private buildPaginatedFooter;
    private buildExecutionSummary;
}
//# sourceMappingURL=response-formatter.d.ts.map