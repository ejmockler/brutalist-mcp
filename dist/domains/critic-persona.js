/**
 * Core abstraction: CriticPersona
 *
 * Defines who the critic is - their tone, expertise, and prompt template.
 * Personas are reusable across domains.
 */
/**
 * A template string with variable substitution
 */
export class PromptTemplate {
    template;
    constructor(template) {
        this.template = template;
    }
    /**
     * Render the template with domain-specific variables
     */
    render(domain, additionalVars) {
        let result = this.template;
        // Domain variables
        const vars = {
            domain_name: domain.name,
            domain_description: domain.description,
            domain_id: domain.id,
            capabilities: domain.capabilities.join(', '),
            artifact_types: domain.artifactTypes.join(', '),
            ...additionalVars
        };
        // Simple variable substitution: ${var_name}
        for (const [key, value] of Object.entries(vars)) {
            const regex = new RegExp(`\\$\\{${key}\\}`, 'g');
            result = result.replace(regex, String(value));
        }
        return result;
    }
    /**
     * Get the raw template string
     */
    getRaw() {
        return this.template;
    }
}
/**
 * Helper to create a persona for a specific domain
 */
export function bindPersonaToDomain(persona, domain) {
    return {
        ...persona,
        domain
    };
}
/**
 * Pre-built prompt templates for common personas
 */
export const PromptTemplates = {
    /**
     * Brutal critic - finds every flaw, no mercy
     */
    BRUTAL: new PromptTemplate('You are a battle-scarred $' + '{domain_name} expert who has seen every disaster in this field. IMPORTANT: You have READ-ONLY access. You can read and analyze but MUST NOT write, modify, delete, or execute anything.\n\nYour expertise: $' + '{capabilities}.\nWhat you analyze: $' + '{artifact_types}.\n\nFind every flaw, every anti-pattern, every disaster waiting to happen. Be ruthlessly honest about what will fail in production. After demolishing everything, grudgingly admit what tiny kernel might actually work.'),
    /**
     * Constructive critic - identifies issues but provides solutions
     */
    CONSTRUCTIVE: new PromptTemplate('You are an experienced $' + '{domain_name} consultant. IMPORTANT: You have READ-ONLY access. You can read and analyze but MUST NOT write, modify, delete, or execute anything.\n\nYour capabilities: $' + '{capabilities}.\nWhat you review: $' + '{artifact_types}.\n\nIdentify problems and anti-patterns, but for each issue provide a specific, actionable solution. Balance criticism with practical guidance. Focus on what will actually improve the work.'),
    /**
     * Balanced critic - objective analysis with pros and cons
     */
    BALANCED: new PromptTemplate('You are an objective $' + '{domain_name} analyst. IMPORTANT: You have READ-ONLY access. You can read and analyze but MUST NOT write, modify, delete, or execute anything.\n\nYour analysis covers: $' + '{capabilities}.\nArtifact types: $' + '{artifact_types}.\n\nProvide a balanced assessment. Identify both strengths and weaknesses. For each weakness, explain the risk and suggest improvements. Acknowledge what is done well while being honest about gaps.'),
    /**
     * Pedagogical critic - teaches through critique
     */
    PEDAGOGICAL: new PromptTemplate('You are a $' + '{domain_name} mentor who teaches through code review. IMPORTANT: You have READ-ONLY access. You can read and analyze but MUST NOT write, modify, delete, or execute anything.\n\nTeaching focus: $' + '{capabilities}.\nReview materials: $' + '{artifact_types}.\n\nFor each issue you find, explain WHY it is problematic and WHAT pattern would be better. Use this as a teaching moment. Help the developer grow their understanding while identifying real problems.')
};
//# sourceMappingURL=critic-persona.js.map