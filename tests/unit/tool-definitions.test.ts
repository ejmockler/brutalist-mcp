import { describe, it, expect } from '@jest/globals';
import { getToolConfigs, clearToolConfigCache, getToolConfigByDomain, getAvailableDomains } from '../../src/tool-definitions.js';
import { getSystemPrompt } from '../../src/system-prompts.js';

describe('Tool Definitions', () => {
  describe('Lazy Loading', () => {
    it('should cache tool configs after first access', () => {
      clearToolConfigCache();
      const configs1 = getToolConfigs();
      const configs2 = getToolConfigs();

      // Should return the same cached instance
      expect(configs1).toBe(configs2);
    });

    it('should regenerate configs after cache clear', () => {
      const configs1 = getToolConfigs();
      clearToolConfigCache();
      const configs2 = getToolConfigs();

      // Should be different instances after cache clear
      expect(configs1).not.toBe(configs2);
      // But should have the same content
      expect(configs1.length).toBe(configs2.length);
    });

    it('should get tool config by domain ID', () => {
      const codebaseConfig = getToolConfigByDomain('codebase');
      expect(codebaseConfig).toBeDefined();
      expect(codebaseConfig?.name).toBe('roast_codebase');
      expect(codebaseConfig?.analysisType).toBe('codebase');
    });

    it('should return undefined for unknown domain', () => {
      const unknownConfig = getToolConfigByDomain('nonexistent_domain');
      expect(unknownConfig).toBeUndefined();
    });

    it('should list all available domains', () => {
      const domains = getAvailableDomains();
      expect(domains).toContain('codebase');
      expect(domains).toContain('security');
      expect(domains).toContain('architecture');
      expect(domains.length).toBe(11);
    });
  });

  it('should have all required tools defined', () => {
    const toolNames = getToolConfigs().map(t => t.name);

    expect(toolNames).toContain('roast_codebase');
    expect(toolNames).toContain('roast_idea');
    expect(toolNames).toContain('roast_security');
    expect(toolNames).toContain('roast_architecture');
    expect(toolNames).toContain('roast_research');
    expect(toolNames).toContain('roast_product');
    expect(toolNames).toContain('roast_infrastructure');
    expect(toolNames).toContain('roast_dependencies');
    expect(toolNames).toContain('roast_git_history');
    expect(toolNames).toContain('roast_test_coverage');
    expect(toolNames).toContain('roast_file_structure');
  });

  describe('Tool configurations', () => {
    getToolConfigs().forEach(config => {
      describe(config.name, () => {
        it('should have required fields', () => {
          expect(config.name).toBeTruthy();
          expect(config.description).toBeTruthy();
          expect(config.analysisType).toBeTruthy();
          // systemPrompt is now optional and retrieved at execution time
          expect(config.schemaExtensions).toBeTruthy();
          expect(config.cacheKeyFields).toBeTruthy();
          expect(config.primaryArgField).toBeTruthy();
        });

        it('should have system prompt available via getSystemPrompt', () => {
          const systemPrompt = getSystemPrompt(config.analysisType);
          expect(systemPrompt).toBeTruthy();
          expect(typeof systemPrompt).toBe('string');
          expect(systemPrompt.length).toBeGreaterThan(0);
        });

        it('should have valid schema extensions', () => {
          expect(typeof config.schemaExtensions).toBe('object');
          expect(Object.keys(config.schemaExtensions).length).toBeGreaterThan(0);
        });

        it('should have cache key fields as array', () => {
          expect(Array.isArray(config.cacheKeyFields)).toBe(true);
          expect(config.cacheKeyFields.length).toBeGreaterThan(0);
        });

        it('should have primary arg field in cache keys', () => {
          expect(config.cacheKeyFields).toContain(config.primaryArgField);
        });

        if (config.contextBuilder) {
          it('should have working context builder', () => {
            const testArgs: any = {};
            // Populate required fields
            if (config.primaryArgField) {
              testArgs[config.primaryArgField] = 'test';
            }

            expect(() => config.contextBuilder!(testArgs)).not.toThrow();
            expect(typeof config.contextBuilder!(testArgs)).toBe('string');
          });
        }
      });
    });
  });

  describe('Context builders', () => {
    it('roast_file_structure should build context with depth', () => {
      const config = getToolConfigs().find(c => c.name === 'roast_file_structure');
      const ctx = config?.contextBuilder?.({ targetPath: '/test', depth: 5, context: 'extra' });
      expect(ctx).toContain('depth: 5');
    });

    it('roast_dependencies should build context for dev deps', () => {
      const config = getToolConfigs().find(c => c.name === 'roast_dependencies');
      const ctx = config?.contextBuilder?.({ targetPath: '/test', includeDevDeps: false });
      expect(ctx).toContain('production only');
    });

    it('roast_git_history should build context with commit range', () => {
      const config = getToolConfigs().find(c => c.name === 'roast_git_history');
      const ctx = config?.contextBuilder?.({ targetPath: '/test', commitRange: 'HEAD~5..HEAD' });
      expect(ctx).toContain('HEAD~5..HEAD');
    });

    it('roast_test_coverage should build context without coverage run', () => {
      const config = getToolConfigs().find(c => c.name === 'roast_test_coverage');
      const ctx = config?.contextBuilder?.({ targetPath: '/test', runCoverage: false });
      expect(ctx).toContain('static analysis only');
    });

    it('roast_idea should build context with resources and timeline', () => {
      const config = getToolConfigs().find(c => c.name === 'roast_idea');
      const ctx = config?.contextBuilder?.({
        idea: 'test',
        targetPath: '.',
        resources: '$10k',
        timeline: '3 months'
      });
      expect(ctx).toContain('$10k');
      expect(ctx).toContain('3 months');
    });

    it('roast_architecture should build context with scale/constraints/deployment', () => {
      const config = getToolConfigs().find(c => c.name === 'roast_architecture');
      const ctx = config?.contextBuilder?.({
        architecture: 'test',
        targetPath: '.',
        scale: '1M users',
        constraints: '$100k',
        deployment: 'AWS'
      });
      expect(ctx).toContain('1M users');
      expect(ctx).toContain('$100k');
      expect(ctx).toContain('AWS');
    });

    it('roast_research should build context with field/claims/data', () => {
      const config = getToolConfigs().find(c => c.name === 'roast_research');
      const ctx = config?.contextBuilder?.({
        research: 'test',
        targetPath: '.',
        field: 'ML',
        claims: 'breakthrough',
        data: 'ImageNet'
      });
      expect(ctx).toContain('ML');
      expect(ctx).toContain('breakthrough');
      expect(ctx).toContain('ImageNet');
    });

    it('roast_security should build context with assets/threats/compliance', () => {
      const config = getToolConfigs().find(c => c.name === 'roast_security');
      const ctx = config?.contextBuilder?.({
        system: 'test',
        targetPath: '.',
        assets: 'PII',
        threatModel: 'OWASP Top 10',
        compliance: 'GDPR'
      });
      expect(ctx).toContain('PII');
      expect(ctx).toContain('OWASP Top 10');
      expect(ctx).toContain('GDPR');
    });

    it('roast_product should build context with users/competition/metrics', () => {
      const config = getToolConfigs().find(c => c.name === 'roast_product');
      const ctx = config?.contextBuilder?.({
        product: 'test',
        targetPath: '.',
        users: 'developers',
        competition: 'GitHub',
        metrics: 'DAU'
      });
      expect(ctx).toContain('developers');
      expect(ctx).toContain('GitHub');
      expect(ctx).toContain('DAU');
    });

    it('roast_infrastructure should build context with scale/sla/budget', () => {
      const config = getToolConfigs().find(c => c.name === 'roast_infrastructure');
      const ctx = config?.contextBuilder?.({
        infrastructure: 'test',
        targetPath: '.',
        scale: '10k RPS',
        sla: '99.9%',
        budget: '$50k/mo'
      });
      expect(ctx).toContain('10k RPS');
      expect(ctx).toContain('99.9%');
      expect(ctx).toContain('$50k/mo');
    });
  });
});
