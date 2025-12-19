import { logger } from '../logger.js';
import {
  BrutalistResponse,
  PaginationParams,
  PaginationMetadata
} from '../types/brutalist.js';
import {
  ResponseChunker,
  createPaginationMetadata,
  formatPaginationStatus,
  estimateTokenCount,
  PAGINATION_DEFAULTS
} from '../utils/pagination.js';

/**
 * ResponseFormatter - Handles all response formatting logic
 * Extracted from BrutalistServer to follow Single Responsibility Principle
 */
export class ResponseFormatter {
  /**
   * Format tool response with optional pagination
   */
  public formatToolResponse(
    result: BrutalistResponse,
    verbose: boolean = false,
    paginationParams?: PaginationParams,
    contextId?: string,
    explicitPaginationRequested: boolean = false
  ) {
    logger.info(`🔧 DEBUG: formatToolResponse called with synthesis length: ${result.synthesis?.length || 0}`);
    logger.info(`🔧 DEBUG: result.success=${result.success}, responses.length=${result.responses?.length || 0}`);
    logger.info(`🔧 DEBUG: pagination params:`, paginationParams);
    logger.info(`🔧 DEBUG: explicitPaginationRequested=${explicitPaginationRequested}`);

    // Get the primary content to paginate
    let primaryContent = '';

    if (result.synthesis) {
      primaryContent = result.synthesis;
      logger.info(`🔧 DEBUG: Using synthesis content (${primaryContent.length} characters)`);
    } else if (result.responses) {
      const successfulResponses = result.responses.filter(r => r.success);
      if (successfulResponses.length > 0) {
        primaryContent = successfulResponses.map(r => r.output).join('\n\n---\n\n');
        logger.info(`🔧 DEBUG: Using raw CLI output (${primaryContent.length} characters)`);
      }
    }

    // Estimate token count to determine if pagination is needed
    const estimatedTokens = estimateTokenCount(primaryContent);
    const maxTokensWithoutPagination = 25000;
    const needsAutoPagination = estimatedTokens > maxTokensWithoutPagination;

    // CRITICAL: Always apply pagination if content is too large, even if not explicitly requested
    // This prevents MCP protocol errors when response exceeds client token limits
    if (needsAutoPagination || explicitPaginationRequested) {
      if (needsAutoPagination && !explicitPaginationRequested) {
        logger.info(`🔧 AUTO-PAGINATING: ${estimatedTokens} tokens exceeds ${maxTokensWithoutPagination} limit - forcing first page`);
        // Force pagination params to show first chunk (use token-based limit)
        const forcedParams: PaginationParams = {
          offset: 0,
          limit: PAGINATION_DEFAULTS.DEFAULT_LIMIT_TOKENS // Use token-based limit
        };
        return this.formatPaginatedResponse(primaryContent, forcedParams, result, verbose, contextId);
      } else if (paginationParams) {
        logger.info(`🔧 DEBUG: Applying pagination (explicitly requested)`);
        return this.formatPaginatedResponse(primaryContent, paginationParams, result, verbose, contextId);
      }
    }

    // Non-paginated response (only for content that fits within token limit)
    if (primaryContent) {
      logger.info(`🔧 DEBUG: Returning full response (${estimatedTokens} tokens < ${maxTokensWithoutPagination} limit)`);

      // Include context_id even for non-paginated responses (for future pagination/caching)
      let responseText = '';
      if (contextId) {
        responseText += `# Brutalist Analysis Results\n\n`;
        responseText += `**🔑 Context ID:** ${contextId}\n\n`;
        responseText += `---\n\n`;
        responseText += primaryContent;
      } else {
        responseText = primaryContent;
      }

      return {
        content: [{
          type: "text" as const,
          text: responseText
        }]
      };
    }

    // Error handling - no successful content
    return this.formatNoContentError(result);
  }

  /**
   * Format paginated response with metadata and navigation
   */
  public formatPaginatedResponse(
    content: string,
    paginationParams: PaginationParams,
    result: BrutalistResponse,
    verbose: boolean,
    contextId?: string
  ) {
    const offset = paginationParams.offset || 0;
    // Convert character-based limit to token-based limit (1 token ≈ 4 chars)
    const limitChars = paginationParams.limit || PAGINATION_DEFAULTS.DEFAULT_LIMIT;
    const limitTokens = Math.ceil(limitChars / 4); // Convert chars to tokens

    logger.info(`🔧 DEBUG: Paginating content - offset: ${offset}, limitChars: ${limitChars}, limitTokens: ${limitTokens}, total: ${content.length} chars`);

    // Use ResponseChunker for intelligent boundary detection (TOKEN-BASED)
    const chunker = new ResponseChunker(limitTokens, PAGINATION_DEFAULTS.CHUNK_OVERLAP_TOKENS);
    const chunks = chunker.chunkText(content);

    // Find the appropriate chunk based on offset
    let targetChunk = chunks[0]; // Default to first chunk
    let targetChunkIndex = 0;

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      if (offset >= chunk.startOffset && offset < chunk.endOffset) {
        targetChunk = chunk;
        targetChunkIndex = i;
        break;
      }
    }

    const chunkContent = targetChunk.content;
    const actualOffset = targetChunk.startOffset;
    const endOffset = targetChunk.endOffset;

    // Create pagination metadata using actual chunk boundaries
    const pagination = createPaginationMetadata(content.length, paginationParams, limitTokens, chunks, targetChunkIndex);
    const statusLine = formatPaginationStatus(pagination);

    // Estimate token usage for user awareness
    const chunkTokens = estimateTokenCount(chunkContent);
    const totalTokens = estimateTokenCount(content);

    // Format response with pagination info
    let paginatedText = this.buildPaginatedHeader(
      pagination,
      contextId,
      chunkTokens,
      totalTokens,
      offset,
      endOffset
    );

    // Add the actual content chunk
    paginatedText += chunkContent;

    // Add footer
    paginatedText += this.buildPaginatedFooter(
      pagination,
      contextId,
      endOffset,
      content.length
    );

    // Add verbose execution details if requested
    if (verbose && result.executionSummary) {
      paginatedText += this.buildExecutionSummary(result.executionSummary);
    }

    logger.info(`🔧 DEBUG: Returning paginated chunk - ${chunkContent.length} chars (${chunkTokens} tokens)`);

    return {
      content: [{
        type: "text" as const,
        text: paginatedText
      }]
    };
  }

  /**
   * Format error response with sanitized message
   */
  public formatErrorResponse(error: unknown) {
    logger.error("Tool execution failed", error);

    // Sanitize error message to prevent information leakage
    let sanitizedMessage = "Analysis failed";

    if (error instanceof Error) {
      // Only expose safe, generic error types
      if (error.message.includes('timeout') || error.message.includes('Timeout')) {
        sanitizedMessage = "Analysis timed out - try reducing scope or increasing timeout";
      } else if (error.message.includes('ENOENT') || error.message.includes('no such file')) {
        sanitizedMessage = "Target path not found - verify the path exists and is accessible";
      } else if (error.message.includes('EACCES') || error.message.includes('permission denied')) {
        sanitizedMessage = "Permission denied - check file access";
      } else if (error.message.includes('No CLI agents available')) {
        sanitizedMessage = "No CLI agents available for analysis";
      } else if (error.message.includes('resume') && error.message.includes('context_id')) {
        // User-facing validation errors for resume/continuation feature
        sanitizedMessage = error.message;
      } else if (error.message.includes('Context ID') && error.message.includes('not found')) {
        // Context ID not found in cache
        sanitizedMessage = error.message;
      } else if (error.message.includes('continuation') && error.message.includes('requires')) {
        // Continuation validation errors
        sanitizedMessage = error.message;
      } else {
        // Generic message for other errors to prevent path/info leakage
        sanitizedMessage = "Analysis failed due to internal error";
      }
    }

    return {
      content: [{
        type: "text" as const,
        text: `Brutalist MCP Error: ${sanitizedMessage}`
      }]
    };
  }

  /**
   * Extract full content from analysis result for caching
   */
  public extractFullContent(result: BrutalistResponse): string | null {
    if (result.synthesis) {
      return result.synthesis;
    } else if (result.responses && result.responses.length > 0) {
      const successfulResponses = result.responses.filter(r => r.success);
      if (successfulResponses.length > 0) {
        let output = `${successfulResponses.length} AI critics have systematically demolished your work.\n\n`;

        successfulResponses.forEach((response, index) => {
          output += `## Critic ${index + 1}: ${response.agent.toUpperCase()}\n`;
          output += `*Execution time: ${response.executionTime}ms*\n\n`;
          output += response.output;
          // Only add separator between critics, not after the last one
          if (index < successfulResponses.length - 1) {
            output += '\n\n---\n\n';
          }
        });

        return output;
      }
    }
    return null;
  }

  // Private helper methods

  private formatNoContentError(result: BrutalistResponse) {
    let errorOutput = '';
    if (result.responses) {
      const failedResponses = result.responses.filter(r => !r.success);
      if (failedResponses.length > 0) {
        errorOutput = `❌ All CLI agents failed:\n` +
                     failedResponses.map(r => `- ${r.agent.toUpperCase()}: ${r.error}`).join('\n');
      } else {
        errorOutput = '❌ No CLI responses available';
      }
    } else {
      errorOutput = '❌ No analysis results';
    }

    return {
      content: [{
        type: "text" as const,
        text: errorOutput
      }]
    };
  }

  private buildPaginatedHeader(
    pagination: PaginationMetadata,
    contextId: string | undefined,
    chunkTokens: number,
    totalTokens: number,
    offset: number,
    endOffset: number
  ): string {
    let header = `# Brutalist Analysis Results\n\n`;

    const needsPagination = pagination.totalChunks > 1 || pagination.hasMore;
    const isFirstRequest = offset === 0;
    const statusLine = formatPaginationStatus(pagination);

    // Always show context_id on first request for future pagination
    if (isFirstRequest && contextId) {
      header += `**🔑 Context ID:** ${contextId}\n`;
      header += `**🔢 Token Estimate:** ~${totalTokens.toLocaleString()} tokens (total)\n\n`;
    }

    if (needsPagination) {
      header += `**📊 Pagination Status:** ${statusLine}\n`;
      if (!isFirstRequest && contextId) {
        header += `**🔑 Context ID:** ${contextId}\n`;
      }
      header += `**🔢 Token Estimate:** ~${chunkTokens.toLocaleString()} tokens (chunk) / ~${totalTokens.toLocaleString()} tokens (total)\n\n`;

      if (pagination.hasMore) {
        if (contextId) {
          header += `**⏭️ Continue Reading:** Use \`context_id: "${contextId}", offset: ${endOffset}\`\n\n`;
        } else {
          header += `**⏭️ Continue Reading:** Use \`offset: ${endOffset}\` for next chunk\n\n`;
        }
      }
    }

    header += `---\n\n`;
    return header;
  }

  private buildPaginatedFooter(
    pagination: PaginationMetadata,
    contextId: string | undefined,
    endOffset: number,
    totalLength: number
  ): string {
    const needsPagination = pagination.totalChunks > 1 || pagination.hasMore;

    if (!needsPagination) {
      return '';
    }

    let footer = `\n\n---\n\n`;
    if (pagination.hasMore) {
      footer += `📖 **End of chunk ${pagination.chunkIndex}/${pagination.totalChunks}**\n`;
      if (contextId) {
        footer += `🔄 To continue: Include \`context_id: "${contextId}"\` with \`offset: ${endOffset}\` in next request`;
      } else {
        footer += `🔄 To continue: Use same tool with \`offset: ${endOffset}\``;
      }
    } else {
      footer += `✅ **Complete analysis shown** (${totalLength.toLocaleString()} characters total)`;
    }

    return footer;
  }

  private buildExecutionSummary(summary: BrutalistResponse['executionSummary']): string {
    if (!summary) return '';

    let text = `\n\n### Execution Summary\n`;
    text += `- **CLI Agents:** ${summary.successfulCLIs}/${summary.totalCLIs} successful\n`;
    text += `- **Total Time:** ${summary.totalExecutionTime}ms\n`;
    if (summary.selectedCLI) {
      text += `- **Selected CLI:** ${summary.selectedCLI}\n`;
    }
    return text;
  }
}
