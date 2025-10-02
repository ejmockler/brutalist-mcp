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
  // Check for null byte injection before any path operations
  if (userPath.includes('\0')) {
    throw new Error(`Path traversal detected`);
  }

  const absoluteProjectRoot = realpathSync(projectRoot);
  
  // For absolute paths, check if they start outside project root immediately
  if (resolve(userPath) === userPath) { // userPath is absolute
    if (!userPath.startsWith(absoluteProjectRoot + sep) && userPath !== absoluteProjectRoot) {
      throw new Error(`Path traversal detected`);
    }
  }
  
  const resolvedPath = resolve(absoluteProjectRoot, userPath);
  
  let absoluteResolvedPath: string;
  const pathExists = existsSync(resolvedPath);
  
  if (pathExists) {
    // Use realpathSync to resolve symlinks and detect traversal for existing paths
    absoluteResolvedPath = realpathSync(resolvedPath);
  } else {
    // For non-existent paths, use logical resolution for traversal detection
    absoluteResolvedPath = resolvedPath;
  }

  // Ensure the resolved path is a sub-path of the project root
  if (!absoluteResolvedPath.startsWith(absoluteProjectRoot + sep) && absoluteResolvedPath !== absoluteProjectRoot) {
    throw new Error(`Path traversal detected`);
  }

  if (mustExist && !pathExists) {
    throw new Error(`Path does not exist: ${userPath}`);
  }

  return absoluteResolvedPath;
}
