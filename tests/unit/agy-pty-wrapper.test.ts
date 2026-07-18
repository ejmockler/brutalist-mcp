import { describe, expect, it } from '@jest/globals';
import { spawn, spawnSync } from 'node:child_process';
import { AGY_PYTHON_WRAPPER } from '../../src/cli-adapters/agy-adapter.js';

const pythonAvailable = spawnSync('python3', ['--version'], { stdio: 'ignore' }).status === 0;
const describePosix = process.platform !== 'win32' && pythonAvailable ? describe : describe.skip;

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitUntilGone(pids: number[], timeoutMs = 2_500): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pids.every((pid) => !isAlive(pid))) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return pids.every((pid) => !isAlive(pid));
}

describePosix('Agy PTY wrapper lifecycle', () => {
  it('cleans stubborn descendants after a normal agy exit', async () => {
    const childCode = [
      'import os, subprocess, sys, time',
      'grandchild = subprocess.Popen([sys.executable, "-c", "import signal, time; signal.signal(signal.SIGTERM, signal.SIG_IGN); time.sleep(60)"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)',
      'print("PIDS=%d,%d" % (os.getpid(), grandchild.pid), flush=True)',
      'time.sleep(0.1)',
    ].join('\n');

    const result = spawnSync(
      'python3',
      ['-c', AGY_PYTHON_WRAPPER, 'python3', '-c', childCode],
      { encoding: 'utf8', timeout: 5_000 },
    );

    expect(result.status).toBe(0);
    expect(result.signal).toBeNull();
    const match = /PIDS=(\d+),(\d+)/.exec(result.stdout);
    expect(match).not.toBeNull();
    const pids = [Number(match?.[1]), Number(match?.[2])];
    expect(await waitUntilGone(pids)).toBe(true);
  });

  it('forwards SIGTERM to the agy process group, including descendants', async () => {
    const childCode = [
      'import os, subprocess, sys, time',
      'grandchild = subprocess.Popen([sys.executable, "-c", "import signal, time; signal.signal(signal.SIGTERM, signal.SIG_IGN); time.sleep(60)"])',
      'print("PIDS=%d,%d" % (os.getpid(), grandchild.pid), flush=True)',
      'time.sleep(60)',
    ].join('\n');
    const wrapper = spawn(
      'python3',
      ['-c', AGY_PYTHON_WRAPPER, 'python3', '-c', childCode],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );

    let stdout = '';
    wrapper.stdout.setEncoding('utf8');
    wrapper.stdout.on('data', (chunk) => { stdout += chunk; });

    const pids = await new Promise<number[]>((resolve, reject) => {
      const deadline = setTimeout(() => reject(new Error('timed out waiting for child PIDs')), 3_000);
      const inspect = () => {
        const match = /PIDS=(\d+),(\d+)/.exec(stdout);
        if (match) {
          clearTimeout(deadline);
          resolve([Number(match[1]), Number(match[2])]);
        }
      };
      wrapper.stdout.on('data', inspect);
      inspect();
    });

    const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      wrapper.once('close', (code, signal) => resolve({ code, signal }));
    });
    wrapper.kill('SIGTERM');
    const result = await Promise.race([
      closed,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('wrapper did not exit')), 4_000)),
    ]);

    expect(result.signal).toBeNull();
    expect(result.code).toBe(143);
    expect(await waitUntilGone(pids)).toBe(true);
  });
});
