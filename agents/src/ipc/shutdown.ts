// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { Logger } from 'pino';
import { IdleTimeoutError, waitUntilTimeout } from '../utils.js';

export const settleShutdownStep = async (
  label: string,
  promise: Promise<unknown>,
  timeoutMs: number,
  logger: Logger,
): Promise<void> => {
  try {
    await waitUntilTimeout(promise, timeoutMs);
  } catch (error) {
    // The timed-out operation may reject later. Keep it observed while the
    // process proceeds toward its guaranteed exit.
    void promise.catch((lateError) =>
      logger.debug({ error: lateError, step: label }, 'shutdown step rejected after timeout'),
    );
    if (error instanceof IdleTimeoutError) {
      logger.error({ step: label, timeout: timeoutMs }, 'shutdown step timed out; continuing');
    } else {
      logger.error({ error, step: label }, 'shutdown step failed; continuing');
    }
  }
};
