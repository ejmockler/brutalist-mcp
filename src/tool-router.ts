import { DOMAINS, getDomain, generateToolConfig } from './registry/domains.js';
import { ToolConfig } from './types/tool-config.js';
import { getToolConfigs } from './tool-definitions.js';

/**
 * Calculate relevance score for a domain based on intent keywords
 */
function calculateRelevance(domain: typeof DOMAINS[keyof typeof DOMAINS], intentWords: string[]): number {
  let score = 0;

  // Check keywords
  for (const keyword of domain.keywords) {
    for (const word of intentWords) {
      if (keyword.includes(word) || word.includes(keyword)) {
        score += 2; // Strong match
      }
    }
  }

  // Check domain name and description
  const domainText = `${domain.name} ${domain.description}`.toLowerCase();
  for (const word of intentWords) {
    if (domainText.includes(word)) {
      score += 1; // Weak match
    }
  }

  return score;
}

/**
 * Filter tools by intent string.
 * Returns top 3 most relevant tools, or all tools if no intent provided.
 */
export function filterToolsByIntent(intent?: string): ToolConfig[] {
  if (!intent || intent.trim() === '') {
    return getToolConfigs();
  }

  const intentLower = intent.toLowerCase();
  const intentWords = intentLower.split(/\s+/).filter(w => w.length > 2);

  // Score each domain
  const scored = Object.values(DOMAINS).map(domain => ({
    domain,
    score: calculateRelevance(domain, intentWords)
  }));

  // Sort by score descending
  scored.sort((a, b) => b.score - a.score);

  // Take top 3 with score > 0, or return all if no matches
  const topMatches = scored.filter(s => s.score > 0).slice(0, 3);

  if (topMatches.length === 0) {
    // No matches - return all tools
    return getToolConfigs();
  }

  // Generate configs for matched domains
  return topMatches.map(s => generateToolConfig(s.domain));
}

/**
 * Get domain IDs that match an intent.
 * Useful for logging and debugging.
 */
export function getMatchingDomainIds(intent: string): string[] {
  const filtered = filterToolsByIntent(intent);
  return filtered.map(t => t.name.replace('roast_', ''));
}
