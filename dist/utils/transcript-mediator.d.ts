export interface TranscriptMediationResult {
    sanitized: string;
    patternsDetected: string[];
}
export type MediationMode = 'sanitize' | 'passthrough';
/**
 * Mediates a debate transcript before injection into the next agent's prompt.
 *
 * In 'sanitize' mode, strips prompt-structure XML tags, shell artifacts from
 * Codex repo exploration, and patterns that resemble system prompt injection.
 * Preserves all argumentative content.
 *
 * In 'passthrough' mode, returns the transcript unchanged (for research).
 */
export declare function mediateTranscript(raw: string, mode?: MediationMode, maxLength?: number): TranscriptMediationResult;
//# sourceMappingURL=transcript-mediator.d.ts.map