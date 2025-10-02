import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { resolve, join } from 'path';
import { mkdirSync, writeFileSync, rmSync, symlinkSync } from 'fs';
import { resolveAndValidatePath } from '../../src/utils.js';

describe('Utils Security Tests', () => {
  const testRoot = resolve(process.cwd(), 'test-temp-utils');
  const projectRoot = join(testRoot, 'project');
  const outsideRoot = join(testRoot, 'outside');

  beforeEach(() => {
    // Clean setup for each test
    try {
      rmSync(testRoot, { recursive: true, force: true });
    } catch {}
    
    mkdirSync(testRoot, { recursive: true });
    mkdirSync(projectRoot, { recursive: true });
    mkdirSync(outsideRoot, { recursive: true });
    mkdirSync(join(projectRoot, 'src'), { recursive: true });
    mkdirSync(join(projectRoot, 'docs'), { recursive: true });
    
    // Create test files
    writeFileSync(join(projectRoot, 'package.json'), '{}');
    writeFileSync(join(projectRoot, 'src', 'index.ts'), 'console.log("test");');
    writeFileSync(join(outsideRoot, 'malicious.txt'), 'pwned');
  });

  afterEach(() => {
    try {
      rmSync(testRoot, { recursive: true, force: true });
    } catch {}
  });

  describe('resolveAndValidatePath', () => {
    describe('Valid Path Resolution', () => {
      it('should resolve relative paths within project root', () => {
        const result = resolveAndValidatePath(projectRoot, 'src/index.ts');
        expect(result).toBe(resolve(projectRoot, 'src', 'index.ts'));
      });

      it('should resolve absolute paths within project root', () => {
        const targetPath = join(projectRoot, 'docs');
        const result = resolveAndValidatePath(projectRoot, targetPath);
        expect(result).toBe(resolve(targetPath));
      });

      it('should handle project root itself', () => {
        const result = resolveAndValidatePath(projectRoot, '.');
        expect(result).toBe(resolve(projectRoot));
      });

      it('should handle nested relative paths', () => {
        const result = resolveAndValidatePath(projectRoot, './src/../docs');
        expect(result).toBe(resolve(projectRoot, 'docs'));
      });
    });

    describe('Path Traversal Attack Prevention', () => {
      it('should reject ../ traversal attempts', () => {
        expect(() => {
          resolveAndValidatePath(projectRoot, '../outside/malicious.txt');
        }).toThrow('Path traversal detected');
      });

      it('should reject absolute paths outside project root', () => {
        expect(() => {
          resolveAndValidatePath(projectRoot, join(outsideRoot, 'malicious.txt'));
        }).toThrow('Path traversal detected');
      });

      it('should reject complex traversal attempts', () => {
        expect(() => {
          resolveAndValidatePath(projectRoot, 'src/../../outside/malicious.txt');
        }).toThrow('Path traversal detected');
      });

      it('should reject attempts to access parent directories', () => {
        expect(() => {
          resolveAndValidatePath(projectRoot, '../../../etc/passwd');
        }).toThrow('Path traversal detected');
      });

      it('should reject null byte injection attempts', () => {
        expect(() => {
          resolveAndValidatePath(projectRoot, 'src/index.ts\0../../../etc/passwd');
        }).toThrow('Path traversal detected');
      });
    });

    describe('Symlink Handling', () => {
      beforeEach(() => {
        try {
          // Create symlink inside project pointing outside
          symlinkSync(outsideRoot, join(projectRoot, 'evil-link'));
          // Create symlink outside project pointing inside  
          symlinkSync(projectRoot, join(outsideRoot, 'good-link'));
        } catch {
          // Skip symlink tests on systems that don't support them
        }
      });

      it('should reject symlinks pointing outside project root', () => {
        try {
          expect(() => {
            resolveAndValidatePath(projectRoot, 'evil-link/malicious.txt');
          }).toThrow('Path traversal detected');
        } catch (setupError) {
          // Skip if symlinks not supported
          if (setupError instanceof Error && setupError.message?.includes('symlink')) {
            return;
          }
          throw setupError;
        }
      });

      it('should reject following external symlinks into project', () => {
        try {
          expect(() => {
            resolveAndValidatePath(projectRoot, join(outsideRoot, 'good-link', 'package.json'));
          }).toThrow('Path traversal detected');
        } catch (setupError) {
          // Skip if symlinks not supported
          if (setupError instanceof Error && setupError.message?.includes('symlink')) {
            return;
          }
          throw setupError;
        }
      });
    });

    describe('File Existence Validation', () => {
      it('should pass when file exists and mustExist is true', () => {
        const result = resolveAndValidatePath(projectRoot, 'src/index.ts', true);
        expect(result).toBe(resolve(projectRoot, 'src', 'index.ts'));
      });

      it('should pass when file does not exist and mustExist is false', () => {
        const result = resolveAndValidatePath(projectRoot, 'nonexistent.txt', false);
        expect(result).toBe(resolve(projectRoot, 'nonexistent.txt'));
      });

      it('should fail when file does not exist and mustExist is true', () => {
        expect(() => {
          resolveAndValidatePath(projectRoot, 'nonexistent.txt', true);
        }).toThrow('Path does not exist: nonexistent.txt');
      });

      it('should fail when directory does not exist and mustExist is true', () => {
        expect(() => {
          resolveAndValidatePath(projectRoot, 'fake-dir/file.txt', true);
        }).toThrow('Path does not exist: fake-dir/file.txt');
      });
    });

    describe('Edge Cases and Malformed Inputs', () => {
      it('should handle empty path strings', () => {
        const result = resolveAndValidatePath(projectRoot, '');
        expect(result).toBe(resolve(projectRoot));
      });

      it('should handle paths with multiple slashes', () => {
        const result = resolveAndValidatePath(projectRoot, 'src//index.ts');
        expect(result).toBe(resolve(projectRoot, 'src', 'index.ts'));
      });

      it('should handle paths with trailing slashes', () => {
        const result = resolveAndValidatePath(projectRoot, 'src/');
        expect(result).toBe(resolve(projectRoot, 'src'));
      });

      it('should reject paths that exactly equal parent directory', () => {
        expect(() => {
          resolveAndValidatePath(projectRoot, '..');
        }).toThrow('Path traversal detected');
      });

      it('should handle unicode characters in paths', () => {
        const unicodePath = 'src/测试文件.ts';
        const result = resolveAndValidatePath(projectRoot, unicodePath);
        expect(result).toBe(resolve(projectRoot, 'src', '测试文件.ts'));
      });
    });

    describe('Error Message Security', () => {
      it('should not leak absolute paths in error messages', () => {
        try {
          resolveAndValidatePath(projectRoot, '../outside/malicious.txt');
        } catch (error) {
          expect(error instanceof Error).toBe(true);
          expect((error as Error).message).not.toContain(testRoot);
          expect((error as Error).message).not.toContain(outsideRoot);
          expect((error as Error).message).toContain('Path traversal detected');
        }
      });

      it('should not leak file system structure in error messages', () => {
        try {
          resolveAndValidatePath(projectRoot, 'secret-file.txt', true);
        } catch (error) {
          expect(error instanceof Error).toBe(true);
          expect((error as Error).message).toContain('Path does not exist: secret-file.txt');
          expect((error as Error).message).not.toContain(projectRoot);
        }
      });
    });
  });
});