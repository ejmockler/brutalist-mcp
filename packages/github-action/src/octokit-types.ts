/**
 * Type alias for the Octokit instance returned by @actions/github.
 * Pulled out so the rest of the codebase doesn't need to grapple with
 * the SDK's nested type exports.
 */
import type { getOctokit } from '@actions/github';

export type Octokit = ReturnType<typeof getOctokit>;
