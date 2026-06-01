/**
 * Core abstraction: CriticPersona
 *
 * Defines who the critic is - their tone, expertise, and prompt template.
 * Personas are reusable across domains.
 */
import { CritiqueDomain } from './critique-domain.js';
export type CriticTone = 'brutal' | 'constructive' | 'balanced' | 'pedagogical';
export type ExpertiseLevel = 'junior' | 'mid' | 'senior' | 'principal' | 'architect';
export interface ModelPreferences {
    claude?: string;
    codex?: string;
    /** agy --print is hard-pinned to Gemini 3.5 Flash (Medium); field reserved for future use. */
    agy?: string;
}
/**
 * A template string with variable substitution
 */
export declare class PromptTemplate {
    private template;
    constructor(template: string);
    /**
     * Render the template with domain-specific variables
     */
    render(domain: CritiqueDomain, additionalVars?: Record<string, any>): string;
    /**
     * Get the raw template string
     */
    getRaw(): string;
}
export interface CriticPersona {
    /** Unique identifier for this persona */
    id: string;
    /** Human-readable name */
    name: string;
    /** Which domain(s) this persona critiques */
    domain?: CritiqueDomain;
    /** The system prompt template */
    promptTemplate: PromptTemplate;
    /** Tone of the critique */
    tone: CriticTone;
    /** Level of expertise */
    expertise: ExpertiseLevel;
    /** Preferred models for this persona */
    preferredModels?: ModelPreferences;
    /** Additional persona characteristics */
    characteristics?: {
        background?: string;
        specialization?: string;
        years_experience?: number;
    };
}
/**
 * Helper to create a persona for a specific domain
 */
export declare function bindPersonaToDomain(persona: CriticPersona, domain: CritiqueDomain): CriticPersona;
/**
 * Pre-built prompt templates for common personas
 */
export declare const PromptTemplates: {
    /**
     * Brutal critic - finds every flaw, no mercy
     */
    BRUTAL: PromptTemplate;
    /**
     * Constructive critic - identifies issues but provides solutions
     */
    CONSTRUCTIVE: PromptTemplate;
    /**
     * Balanced critic - objective analysis with pros and cons
     */
    BALANCED: PromptTemplate;
    /**
     * Pedagogical critic - teaches through critique
     */
    PEDAGOGICAL: PromptTemplate;
};
//# sourceMappingURL=critic-persona.d.ts.map