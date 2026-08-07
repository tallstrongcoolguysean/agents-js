// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { Logger } from 'pino';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { settleShutdownStep } from './shutdown.js';

function createLogger() {
  return {
    debug: vi.fn(),
    error: vi.fn(),
  } as unknown as Logger;
}

describe('job process shutdown steps', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('continues after a shutdown step exceeds its deadline', async () => {
    vi.useFakeTimers();
    const logger = createLogger();
    const step = settleShutdownStep('stuck cleanup', new Promise(() => {}), 100, logger);

    await vi.advanceTimersByTimeAsync(100);
    await expect(step).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalledWith(
      { step: 'stuck cleanup', timeout: 100 },
      'shutdown step timed out; continuing',
    );
  });

  it('continues after a shutdown step rejects', async () => {
    const logger = createLogger();
    const error = new Error('cleanup failed');

    await expect(
      settleShutdownStep('failed cleanup', Promise.reject(error), 100, logger),
    ).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalledWith(
      { error, step: 'failed cleanup' },
      'shutdown step failed; continuing',
    );
  });
});
