/**
 * Persona Registry: All built-in critic personas
 *
 * Personas are reusable across domains - same brutal critic can review security or architecture.
 */

import { CriticPersona, PromptTemplates } from '../domains/critic-persona.js';

export const PERSONAS: Record<string, CriticPersona> = {
  BRUTAL_CRITIC: {
    id: 'brutal_critic',
    name: 'Brutal Critic',
    promptTemplate: PromptTemplates.BRUTAL,
    tone: 'brutal',
    expertise: 'principal',
    characteristics: {
      background: 'Battle-scarred engineer who has debugged production disasters for 15+ years',
      specialization: 'Finding what will break in production',
      years_experience: 15
    }
  },

  CONSTRUCTIVE_CONSULTANT: {
    id: 'constructive_consultant',
    name: 'Constructive Consultant',
    promptTemplate: PromptTemplates.CONSTRUCTIVE,
    tone: 'constructive',
    expertise: 'senior',
    characteristics: {
      background: 'Experienced consultant who balances criticism with practical guidance',
      specialization: 'Actionable improvements',
      years_experience: 10
    }
  },

  BALANCED_ANALYST: {
    id: 'balanced_analyst',
    name: 'Balanced Analyst',
    promptTemplate: PromptTemplates.BALANCED,
    tone: 'balanced',
    expertise: 'senior',
    characteristics: {
      background: 'Objective analyst who weighs pros and cons',
      specialization: 'Risk assessment',
      years_experience: 8
    }
  },

  PEDAGOGICAL_MENTOR: {
    id: 'pedagogical_mentor',
    name: 'Pedagogical Mentor',
    promptTemplate: PromptTemplates.PEDAGOGICAL,
    tone: 'pedagogical',
    expertise: 'architect',
    characteristics: {
      background: 'Mentor who teaches through code review',
      specialization: 'Developer growth',
      years_experience: 12
    }
  }
};

/**
 * Helper to get a persona by ID
 */
export function getPersona(id: string): CriticPersona | undefined {
  return Object.values(PERSONAS).find(p => p.id === id);
}

/**
 * Helper to list all personas
 */
export function listPersonas(): CriticPersona[] {
  return Object.values(PERSONAS);
}

/**
 * Helper to find personas by tone
 */
export function findPersonasByTone(tone: string): CriticPersona[] {
  return Object.values(PERSONAS).filter(p => p.tone === tone);
}
