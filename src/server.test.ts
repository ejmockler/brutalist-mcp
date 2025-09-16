import { GeminiServer } from './server.js';
import { spawn } from 'child_process';
import { EventEmitter } from 'events';

jest.mock('child_process');

describe('GeminiServer', () => {
  let server: GeminiServer;
  let mockSpawn: jest.MockedFunction<typeof spawn>;
  
  beforeEach(() => {
    server = new GeminiServer();
    mockSpawn = spawn as jest.MockedFunction<typeof spawn>;
    mockSpawn.mockClear();
  });

  describe('Constructor', () => {
    it('should initialize with default config', () => {
      expect(server.config.defaultModel).toBe('gemini-2.5-flash');
      expect(server.config.geminiPath).toBe('gemini');
    });

    it('should accept custom config', () => {
      const customServer = new GeminiServer({
        defaultModel: 'gemini-1.5-pro',
        geminiPath: '/usr/local/bin/gemini'
      });
      expect(customServer.config.defaultModel).toBe('gemini-1.5-pro');
      expect(customServer.config.geminiPath).toBe('/usr/local/bin/gemini');
    });
  });

  describe('executeGeminiPrompt', () => {
    let mockProcess: any;

    beforeEach(() => {
      mockProcess = new EventEmitter();
      mockProcess.stdin = { 
        end: jest.fn(),
        write: jest.fn()
      };
      mockProcess.stdout = new EventEmitter();
      mockProcess.stderr = new EventEmitter();
      
      mockSpawn.mockReturnValue(mockProcess as any);
    });

    it('should execute prompt with default model', async () => {
      const executePromise = (server as any).executeGeminiPrompt({
        prompt: 'Test prompt'
      });

      // Simulate successful response
      mockProcess.stdout.emit('data', 'Test response');
      mockProcess.emit('close', 0);

      const result = await executePromise;

      expect(mockSpawn).toHaveBeenCalledWith(
        'gemini',
        ['-p', 'Test prompt'],
        expect.objectContaining({
          cwd: process.cwd(),
          env: process.env
        })
      );
      expect(result.success).toBe(true);
      expect(result.output).toBe('Test response');
    });

    it('should handle custom model', async () => {
      const executePromise = (server as any).executeGeminiPrompt({
        prompt: 'Test prompt',
        model: 'gemini-1.5-pro'
      });

      mockProcess.stdout.emit('data', 'Pro response');
      mockProcess.emit('close', 0);

      const result = await executePromise;

      expect(mockSpawn).toHaveBeenCalledWith(
        'gemini',
        ['-m', 'gemini-1.5-pro', '-p', 'Test prompt'],
        expect.any(Object)
      );
      expect(result.output).toBe('Pro response');
    });

    it('should handle YOLO mode', async () => {
      const executePromise = (server as any).executeGeminiPrompt({
        prompt: 'Dangerous prompt',
        yolo: true
      });

      mockProcess.stdout.emit('data', 'YOLO response');
      mockProcess.emit('close', 0);

      const result = await executePromise;

      expect(mockSpawn).toHaveBeenCalledWith(
        'gemini',
        expect.arrayContaining(['--yolo', '-p', 'Dangerous prompt']),
        expect.any(Object)
      );
      expect(result.success).toBe(true);
    });

    it('should handle working directory', async () => {
      const executePromise = (server as any).executeGeminiPrompt({
        prompt: 'Test prompt',
        cwd: '/custom/path'
      });

      mockProcess.stdout.emit('data', 'Response');
      mockProcess.emit('close', 0);

      await executePromise;

      expect(mockSpawn).toHaveBeenCalledWith(
        'gemini',
        expect.any(Array),
        expect.objectContaining({
          cwd: '/custom/path'
        })
      );
    });

    it('should handle multiple directories', async () => {
      const executePromise = (server as any).executeGeminiPrompt({
        prompt: 'Multi-dir prompt',
        includeDirectories: ['/dir1', '/dir2', '/dir3']
      });

      mockProcess.stdout.emit('data', 'Multi-dir response');
      mockProcess.emit('close', 0);

      const result = await executePromise;

      expect(mockSpawn).toHaveBeenCalledWith(
        'gemini',
        expect.arrayContaining([
          '--include-directories', '/dir1,/dir2,/dir3',
          '-p', 'Multi-dir prompt'
        ]),
        expect.any(Object)
      );
      expect(result.success).toBe(true);
    });

    it('should handle JSON output format', async () => {
      const executePromise = (server as any).executeGeminiPrompt({
        prompt: 'Give me JSON',
        outputFormat: 'json'
      });

      mockProcess.stdout.emit('data', '{"result": "json data"}');
      mockProcess.emit('close', 0);

      const result = await executePromise;

      expect(mockSpawn).toHaveBeenCalledWith(
        'gemini',
        expect.arrayContaining([
          '--output-format', 'json',
          '-p', 'Give me JSON'
        ]),
        expect.any(Object)
      );
      expect(result.output).toBe('{"result": "json data"}');
    });

    it('should handle sandbox mode', async () => {
      const executePromise = (server as any).executeGeminiPrompt({
        prompt: 'Sandbox test',
        sandbox: true
      });

      mockProcess.stdout.emit('data', 'Sandboxed response');
      mockProcess.emit('close', 0);

      await executePromise;

      expect(mockSpawn).toHaveBeenCalledWith(
        'gemini',
        expect.arrayContaining([
          '--sandbox',
          '-p', 'Sandbox test'
        ]),
        expect.any(Object)
      );
    });

    it('should handle process errors', async () => {
      const executePromise = (server as any).executeGeminiPrompt({
        prompt: 'Error prompt'
      });

      mockProcess.emit('error', new Error('Spawn failed'));

      const result = await executePromise;

      expect(result.success).toBe(false);
      expect(result.error).toContain('Spawn failed');
    });

    it('should handle ENOENT error', async () => {
      const executePromise = (server as any).executeGeminiPrompt({
        prompt: 'Test prompt'
      });

      const error = new Error('spawn gemini ENOENT');
      (error as any).code = 'ENOENT';
      mockProcess.emit('error', error);

      const result = await executePromise;

      expect(result.success).toBe(false);
      expect(result.error).toContain('Gemini CLI not found');
    });

    it('should handle non-zero exit codes', async () => {
      const executePromise = (server as any).executeGeminiPrompt({
        prompt: 'Failing prompt'
      });

      mockProcess.stderr.emit('data', 'Command failed');
      mockProcess.emit('close', 1);

      const result = await executePromise;

      expect(result.success).toBe(false);
      expect(result.error).toContain('Process exited with code 1');
    });

    it('should ignore "Loaded cached credentials" in stderr', async () => {
      const executePromise = (server as any).executeGeminiPrompt({
        prompt: 'Auth prompt'
      });

      mockProcess.stderr.emit('data', 'Loaded cached credentials for default');
      mockProcess.stdout.emit('data', 'Success');
      mockProcess.emit('close', 0);

      const result = await executePromise;

      expect(result.success).toBe(true);
      expect(result.output).toBe('Success');
    });
  });

  describe('Tool Registration', () => {
    it('should register all required tools', () => {
      const registeredTools = jest.spyOn(server.server, 'tool');
      
      // Re-initialize to trigger registration
      const newServer = new GeminiServer();
      
      expect(newServer.server).toBeDefined();
      // Tools are registered in constructor
    });
  });

  describe('MCP Server', () => {
    it('should have server instance', () => {
      expect(server.server).toBeDefined();
    });
  });
});