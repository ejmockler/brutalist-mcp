/**
 * Persona Registry: All built-in critic personas
 *
 * Personas are reusable across domains - same brutal critic can review security or architecture.
 */
import { CriticPersona } from '../domains/critic-persona.js';
export declare const PERSONAS: Record<string, CriticPersona>;
/**
 * Helper to get a persona by ID
 */
export declare function getPersona(id: string): CriticPersona | undefined;
/**
 * Helper to list all personas
 */
export declare function listPersonas(): CriticPersona[];
/**
 * Helper to find personas by tone
 */
export declare function findPersonasByTone(tone: string): CriticPersona[];
//# sourceMappingURL=personas.d.ts.map