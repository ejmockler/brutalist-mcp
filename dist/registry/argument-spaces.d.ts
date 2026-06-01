/**
 * Argument Space Registry: Pre-built reusable argument schemas
 *
 * Import these to avoid duplication across tool definitions.
 */
import { ArgumentSpace } from '../domains/argument-space.js';
/**
 * All built-in argument spaces
 */
export declare const ARGUMENT_SPACES: Record<string, ArgumentSpace>;
/**
 * Helper to get an argument space by ID
 */
export declare function getArgumentSpace(id: string): ArgumentSpace | undefined;
/**
 * Helper to list all argument spaces
 */
export declare function listArgumentSpaces(): ArgumentSpace[];
//# sourceMappingURL=argument-spaces.d.ts.map