import { resolve, join, sep } from 'path';
import { realpathSync, existsSync } from 'fs';

/**
 * Resolves a given path and validates that it is within the allowed project root.
 * Prevents path traversal attacks.
 * @param projectRoot The absolute path to the project root directory.
 * @param userPath The user-provided path (can be relative or absolute).
 * @param mustExist If true, the resolved path must exist on the filesystem.
 * @returns The resolved, validated absolute path.
 * @throws Error if the path is outside the project root or does not exist (if mustExist is true).
 */
export function resolveAndValidatePath(
  projectRoot: string,
  userPath: string,
  mustExist: boolean = false
): string {
  const absoluteProjectRoot = realpathSync(projectRoot);
  const resolvedPath = resolve(absoluteProjectRoot, userPath);
  const absoluteResolvedPath = realpathSync(resolvedPath);

  // Ensure the resolved path is a sub-path of the project root
  if (!absoluteResolvedPath.startsWith(absoluteProjectRoot + sep) && absoluteResolvedPath !== absoluteProjectRoot) {
    throw new Error(`Path traversal detected: ${userPath} resolves outside project root.`);
  }

  if (mustExist && !existsSync(absoluteResolvedPath)) {
    throw new Error(`Path does not exist: ${userPath}`);
  }

  return absoluteResolvedPath;
}
