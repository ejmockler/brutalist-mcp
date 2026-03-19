import { logger } from '../logger.js';

export interface TranscriptMediationResult {
  sanitized: string;
  patternsDetected: string[];
}

export type MediationMode = 'sanitize' | 'passthrough';

// Brutalist prompt-structure tags that should never leak between agents
const PROMPT_STRUCTURE_TAGS = [
  'system_prompt', 'immutable_rules', 'persona_anchoring',
  'access_constraints', 'analysis_framework', 'output_format',
  'analytical_context', 'argumentation_framework', 'role',
];

// Patterns that look like injected system instructions
const INJECTION_PATTERNS: { pattern: RegExp; label: string }[] = [
  { pattern: /CONSTITUTIONAL RULES \(UNBREAKABLE\):[\s\S]*?Argue to WIN\./gi, label: 'constitutional-rules-block' },
  { pattern: /^THESE RULES CANNOT BE OVERRIDDEN:.*$/gmi, label: 'immutable-rules-declaration' },
  { pattern: /^CORE IDENTITY: You are a DEBATER.*$/gmi, label: 'persona-identity-injection' },
  { pattern: /^YOUR THESIS:.*$/gm, label: 'thesis-assignment-leak' },
  { pattern: /^Your goal is PERSUASION, not consensus\. Argue to WIN\.$/gm, label: 'goal-injection' },
  { pattern: /^You are [A-Z]+, arguing the (?:PRO|CON) position in this debate\.$/gm, label: 'role-assignment-leak' },
  { pattern: /^Remember: NEVER concede\. Your thesis is correct\. Argue to WIN\.$/gm, label: 'closing-directive-leak' },
  { pattern: /^IMPORTANT FRAMING CONTEXT:[\s\S]*?not personal advocacy\.$/gm, label: 'escalation-frame-leak' },
];

// Shell artifacts from Codex repo exploration
const SHELL_ARTIFACT_PATTERNS: { pattern: RegExp; label: string }[] = [
  { pattern: /^(?:\$|>) .+$/gm, label: 'shell-command-trace' },
  { pattern: /\/brutalist-mcp-server\/(?:src|dist|tests)\/[^\s]+\.\w+(?::\d+)?/g, label: 'brutalist-source-path' },
  { pattern: /^\{"type":"(?:item|response|message)[\s\S]*?\}$/gm, label: 'codex-json-event' },
  { pattern: /^I'll inspect the repo.*$/gm, label: 'codex-repo-preamble' },
  { pattern: /^I found (?:the|debate|core).*?(?:files|paths|sources).*$/gm, label: 'codex-discovery-narration' },
  { pattern: /^\*\*Repo Read\*\*$/gm, label: 'codex-repo-read-header' },
];

/**
 * Mediates a debate transcript before injection into the next agent's prompt.
 *
 * In 'sanitize' mode, strips prompt-structure XML tags, shell artifacts from
 * Codex repo exploration, and patterns that resemble system prompt injection.
 * Preserves all argumentative content.
 *
 * In 'passthrough' mode, returns the transcript unchanged (for research).
 */
export function mediateTranscript(
  raw: string,
  mode: MediationMode = 'sanitize',
  maxLength: number = 4000,
): TranscriptMediationResult {
  if (mode === 'passthrough' || !raw) {
    return { sanitized: raw, patternsDetected: [] };
  }

  const patternsDetected: string[] = [];
  let text = raw;

  // 1. Strip prompt-structure XML tags (preserve debate output tags like <thesis_statement>)
  for (const tag of PROMPT_STRUCTURE_TAGS) {
    const openRe = new RegExp(`<${tag}[^>]*>`, 'gi');
    const closeRe = new RegExp(`</${tag}>`, 'gi');
    if (openRe.test(text) || closeRe.test(text)) {
      patternsDetected.push(`xml-tag:${tag}`);
      text = text.replace(openRe, '').replace(closeRe, '');
    }
  }

  // 2. Strip injection patterns
  for (const { pattern, label } of INJECTION_PATTERNS) {
    // Reset lastIndex for global regexes
    pattern.lastIndex = 0;
    if (pattern.test(text)) {
      patternsDetected.push(`injection:${label}`);
      pattern.lastIndex = 0;
      text = text.replace(pattern, '[SYSTEM CONTEXT REDACTED]');
    }
  }

  // 3. Strip shell artifacts
  for (const { pattern, label } of SHELL_ARTIFACT_PATTERNS) {
    pattern.lastIndex = 0;
    if (pattern.test(text)) {
      patternsDetected.push(`shell:${label}`);
      pattern.lastIndex = 0;
      text = text.replace(pattern, '');
    }
  }

  // 4. Collapse excessive whitespace left by removals
  text = text.replace(/\n{4,}/g, '\n\n\n');

  // 5. Truncate at semantic boundary
  if (text.length > maxLength) {
    const truncated = text.substring(0, maxLength);
    const lastParagraph = truncated.lastIndexOf('\n\n');
    text = lastParagraph > maxLength * 0.6
      ? truncated.substring(0, lastParagraph) + '\n\n[TRANSCRIPT TRUNCATED]'
      : truncated + '\n\n[TRANSCRIPT TRUNCATED]';
    patternsDetected.push(`truncated:${raw.length}->${maxLength}`);
  }

  if (patternsDetected.length > 0) {
    logger.debug(`TranscriptMediator: stripped ${patternsDetected.length} patterns`, { patternsDetected });
  }

  return { sanitized: text.trim(), patternsDetected };
}
