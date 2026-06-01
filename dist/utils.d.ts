/**
 * Resolves a given path and validates that it is within the allowed project root.
 * Prevents path traversal attacks.
 * @param projectRoot The absolute path to the project root directory.
 * @param userPath The user-provided path (can be relative or absolute).
 * @param mustExist If true, the resolved path must exist on the filesystem.
 * @returns The resolved, validated absolute path.
 * @throws Error if the path is outside the project root or does not exist (if mustExist is true).
 */
export declare function resolveAndValidatePath(projectRoot: string, userPath: string, mustExist?: boolean): Promise<string>;
//# sourceMappingURL=utils.d.ts.map