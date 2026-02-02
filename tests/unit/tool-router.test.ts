import { filterToolsByIntent, getMatchingDomainIds } from '../../src/tool-router.js';
import { DOMAINS } from '../../src/registry/domains.js';

describe('Tool Router', () => {
  describe('filterToolsByIntent', () => {
    it('should return all tools when no intent provided', () => {
      const tools = filterToolsByIntent();
      expect(tools.length).toBe(Object.keys(DOMAINS).length);
    });

    it('should return all tools when empty intent provided', () => {
      const tools = filterToolsByIntent('');
      expect(tools.length).toBe(Object.keys(DOMAINS).length);
    });

    it('should match security-related domains', () => {
      const tools = filterToolsByIntent('security vulnerability');
      expect(tools.length).toBeLessThanOrEqual(3);
      expect(tools.some(t => t.name === 'roast_security')).toBe(true);
    });

    it('should match code-related domains', () => {
      const tools = filterToolsByIntent('code review quality');
      expect(tools.length).toBeLessThanOrEqual(3);
      expect(tools.some(t => t.name === 'roast_codebase')).toBe(true);
    });

    it('should match test-related domains', () => {
      const tools = filterToolsByIntent('testing coverage');
      expect(tools.length).toBeLessThanOrEqual(3);
      expect(tools.some(t => t.name === 'roast_test_coverage')).toBe(true);
    });

    it('should match architecture-related domains', () => {
      const tools = filterToolsByIntent('architecture design system');
      expect(tools.length).toBeLessThanOrEqual(3);
      expect(tools.some(t => t.name === 'roast_architecture')).toBe(true);
    });

    it('should match infrastructure-related domains', () => {
      const tools = filterToolsByIntent('devops cloud infrastructure');
      expect(tools.length).toBeLessThanOrEqual(3);
      expect(tools.some(t => t.name === 'roast_infrastructure')).toBe(true);
    });

    it('should match dependency-related domains', () => {
      const tools = filterToolsByIntent('npm packages dependencies');
      expect(tools.length).toBeLessThanOrEqual(3);
      expect(tools.some(t => t.name === 'roast_dependencies')).toBe(true);
    });

    it('should match git-related domains', () => {
      const tools = filterToolsByIntent('git commits history');
      expect(tools.length).toBeLessThanOrEqual(3);
      expect(tools.some(t => t.name === 'roast_git_history')).toBe(true);
    });

    it('should match idea-related domains', () => {
      const tools = filterToolsByIntent('startup idea feasibility');
      expect(tools.length).toBeLessThanOrEqual(3);
      expect(tools.some(t => t.name === 'roast_idea')).toBe(true);
    });

    it('should match research-related domains', () => {
      const tools = filterToolsByIntent('research methodology academic');
      expect(tools.length).toBeLessThanOrEqual(3);
      expect(tools.some(t => t.name === 'roast_research')).toBe(true);
    });

    it('should match product-related domains', () => {
      const tools = filterToolsByIntent('product ux user experience');
      expect(tools.length).toBeLessThanOrEqual(3);
      expect(tools.some(t => t.name === 'roast_product')).toBe(true);
    });

    it('should match file structure domains', () => {
      const tools = filterToolsByIntent('files directory organization');
      expect(tools.length).toBeLessThanOrEqual(3);
      expect(tools.some(t => t.name === 'roast_file_structure')).toBe(true);
    });

    it('should return all tools for unmatched intent', () => {
      const tools = filterToolsByIntent('xyz quantum blockchain ai');
      // Should return all tools when no matches found
      expect(tools.length).toBe(Object.keys(DOMAINS).length);
    });

    it('should handle multi-word intents', () => {
      const tools = filterToolsByIntent('review my authentication security');
      expect(tools.length).toBeLessThanOrEqual(3);
      expect(tools.some(t => t.name === 'roast_security')).toBe(true);
    });

    it('should filter out words <= 2 characters', () => {
      const tools = filterToolsByIntent('my in at security');
      expect(tools.length).toBeLessThanOrEqual(3);
      expect(tools.some(t => t.name === 'roast_security')).toBe(true);
    });
  });

  describe('getMatchingDomainIds', () => {
    it('should return domain IDs for security intent', () => {
      const domainIds = getMatchingDomainIds('security');
      expect(domainIds).toContain('security');
      expect(domainIds.length).toBeLessThanOrEqual(3);
    });

    it('should return domain IDs for code intent', () => {
      const domainIds = getMatchingDomainIds('code review');
      expect(domainIds).toContain('codebase');
      expect(domainIds.length).toBeLessThanOrEqual(3);
    });

    it('should return all domain IDs for unmatched intent', () => {
      const domainIds = getMatchingDomainIds('xyz quantum');
      expect(domainIds.length).toBe(Object.keys(DOMAINS).length);
    });

    it('should strip roast_ prefix from tool names', () => {
      const domainIds = getMatchingDomainIds('security');
      domainIds.forEach(id => {
        expect(id).not.toMatch(/^roast_/);
      });
    });
  });

  describe('relevance scoring', () => {
    it('should prioritize strong keyword matches', () => {
      const tools = filterToolsByIntent('security vulnerability threat');
      // Security should be first due to multiple strong keyword matches
      expect(tools[0].name).toBe('roast_security');
    });

    it('should handle case insensitivity', () => {
      const toolsLower = filterToolsByIntent('security');
      const toolsUpper = filterToolsByIntent('SECURITY');
      const toolsMixed = filterToolsByIntent('SeCuRiTy');

      // Compare names instead of full objects (functions don't compare equal)
      expect(toolsLower.map(t => t.name)).toEqual(toolsUpper.map(t => t.name));
      expect(toolsLower.map(t => t.name)).toEqual(toolsMixed.map(t => t.name));
    });

    it('should return top 3 matches when many domains match', () => {
      // This intent could match multiple domains
      const tools = filterToolsByIntent('code');
      expect(tools.length).toBeLessThanOrEqual(3);
    });
  });
});
