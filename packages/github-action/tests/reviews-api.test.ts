import { describe, it, expect, jest } from '@jest/globals';
import { submitReview } from '../src/reviews-api.js';
import type { OrchestratorResult } from '@brutalist/orchestrator';

const PULL = {
  owner: 'acme',
  repo: 'auth',
  number: 1,
  baseSha: 'a',
  headSha: 'b',
};
const RESULT: OrchestratorResult = {
  schemaVersion: 1,
  findings: [],
  perCli: [],
  synthesis: '',
  outOfDiff: [],
};

function makeOctokit(createReview: any): any {
  return { rest: { pulls: { createReview } } };
}

describe('submitReview retry/backoff', () => {
  it('retries on 5xx and succeeds on second attempt', async () => {
    const createReview = jest
      .fn<any>()
      .mockRejectedValueOnce(Object.assign(new Error('bad gateway'), { status: 502 }))
      .mockResolvedValueOnce({ data: { id: 7, html_url: 'https://example/7' } });
    const sleep = jest.fn<any>().mockResolvedValue(undefined);

    const result = await submitReview(
      makeOctokit(createReview),
      { pull: PULL, groups: [], outOfDiff: [], dropped: [], result: RESULT },
      { maxAttempts: 3, baseDelayMs: 1, sleep },
    );

    expect(result.reviewId).toBe(7);
    expect(createReview).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it('does NOT retry on 4xx (programmer errors should not waste retries)', async () => {
    const createReview = jest
      .fn<any>()
      .mockRejectedValue(Object.assign(new Error('unprocessable'), { status: 422 }));
    const sleep = jest.fn<any>().mockResolvedValue(undefined);

    await expect(
      submitReview(
        makeOctokit(createReview),
        { pull: PULL, groups: [], outOfDiff: [], dropped: [], result: RESULT },
        { maxAttempts: 3, baseDelayMs: 1, sleep },
      ),
    ).rejects.toThrow(/HTTP 422/);

    expect(createReview).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('exhausts attempts on persistent 5xx and surfaces the last error', async () => {
    const createReview = jest
      .fn<any>()
      .mockRejectedValue(Object.assign(new Error('service unavailable'), { status: 503 }));
    const sleep = jest.fn<any>().mockResolvedValue(undefined);

    await expect(
      submitReview(
        makeOctokit(createReview),
        { pull: PULL, groups: [], outOfDiff: [], dropped: [], result: RESULT },
        { maxAttempts: 3, baseDelayMs: 1, sleep },
      ),
    ).rejects.toThrow(/service unavailable/);

    expect(createReview).toHaveBeenCalledTimes(3);
    // Two backoff sleeps between three attempts.
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it('on 422 with comments, retries without comments and returns success (positive-path fallback)', async () => {
    const createReview = jest
      .fn<any>()
      // First call: 422 with full comments array.
      .mockRejectedValueOnce(Object.assign(new Error('unprocessable'), { status: 422 }))
      // Second call (the fallback): succeeds with empty comments.
      .mockResolvedValueOnce({ data: { id: 99, html_url: 'https://example/99' } });
    const sleep = jest.fn<any>().mockResolvedValue(undefined);

    const result = await submitReview(
      makeOctokit(createReview),
      {
        pull: PULL,
        groups: [
          // Non-empty so the fallback's `comments.length > 0` gate fires.
          { path: 'a.ts', line: 1, side: 'RIGHT', rollupSeverity: 'high', findings: [], body: 'x' },
        ] as any,
        outOfDiff: [],
        dropped: [],
        result: RESULT,
      },
      { maxAttempts: 1, baseDelayMs: 1, sleep },
    );

    expect(result.reviewId).toBe(99);
    expect(createReview).toHaveBeenCalledTimes(2);
    // Second call had comments stripped to []
    const secondCall = createReview.mock.calls[1][0] as { comments: unknown[]; body: string };
    expect(secondCall.comments).toEqual([]);
    // ... and a degraded notice appended to the summary body
    expect(secondCall.body).toMatch(/Inline comments dropped/);
  });

  it('on 422 fallback also failing, surfaces the ORIGINAL 422 diagnostic (not the secondary error)', async () => {
    // The 422's diagnostic includes the sample path:line:side triplet
    // — that's what tells the user which comment fell outside the
    // diff. The fallback's own failure (e.g. transient 500) loses that
    // information. Preserve the original.
    const createReview = jest
      .fn<any>()
      .mockRejectedValueOnce(Object.assign(new Error('unprocessable'), { status: 422 }))
      .mockRejectedValueOnce(Object.assign(new Error('fallback also failed'), { status: 500 }));
    const sleep = jest.fn<any>().mockResolvedValue(undefined);

    await expect(
      submitReview(
        makeOctokit(createReview),
        {
          pull: PULL,
          groups: [
            { path: 'a.ts', line: 1, side: 'RIGHT', rollupSeverity: 'high', findings: [], body: 'x' },
          ] as any,
          outOfDiff: [],
          dropped: [],
          result: RESULT,
        },
        { maxAttempts: 1, baseDelayMs: 1, sleep },
      ),
    ).rejects.toThrow(/HTTP 422/);
  });

  it('uses exponential backoff (base, base*2, base*4)', async () => {
    const createReview = jest
      .fn<any>()
      .mockRejectedValue(Object.assign(new Error('boom'), { status: 500 }));
    const sleep = jest.fn<any>().mockResolvedValue(undefined);

    await expect(
      submitReview(
        makeOctokit(createReview),
        { pull: PULL, groups: [], outOfDiff: [], dropped: [], result: RESULT },
        { maxAttempts: 4, baseDelayMs: 100, sleep },
      ),
    ).rejects.toThrow();

    // baseDelayMs * 2^(attempt-1): 100, 200, 400 (3 sleeps for 4 attempts)
    expect(sleep).toHaveBeenNthCalledWith(1, 100);
    expect(sleep).toHaveBeenNthCalledWith(2, 200);
    expect(sleep).toHaveBeenNthCalledWith(3, 400);
  });
});
