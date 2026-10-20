// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { ChildProcess } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import type { RunningJobInfo } from '../job.js';
import { JobProcExecutor } from './job_proc_executor.js';

function createExecutor(proc: Partial<ChildProcess>) {
  const executor = new JobProcExecutor('agent.js', undefined, 1000, 1000, 0, 0, 1000, 1000, 1000);
  (executor as unknown as { init: { resolve: () => void } }).init.resolve();
  executor.proc = proc as ChildProcess;
  return executor;
}

const runningJob = { job: { id: 'job-id' } } as unknown as RunningJobInfo;

describe('JobProcExecutor.notifyDraining', () => {
  it('sends the drain notice to a process with a running job', async () => {
    const send = vi.fn();
    const executor = createExecutor({ connected: true, send });
    await executor.launchJob(runningJob);

    executor.notifyDraining();

    expect(send).toHaveBeenLastCalledWith(
      { case: 'drainRequest', value: undefined },
      expect.any(Function),
    );
  });

  it('sends nothing to an idle process', () => {
    const send = vi.fn();
    const executor = createExecutor({ connected: true, send });

    executor.notifyDraining();

    expect(send).not.toHaveBeenCalled();
  });

  it('sends nothing once the process has disconnected', async () => {
    const send = vi.fn();
    const proc = { connected: true, send };
    const executor = createExecutor(proc);
    await executor.launchJob(runningJob);
    send.mockClear();
    proc.connected = false;

    executor.notifyDraining();

    expect(send).not.toHaveBeenCalled();
  });

  it('never throws when the channel is closing', async () => {
    const send = vi.fn((message: { case: string }) => {
      if (message.case === 'drainRequest') throw new Error('channel closed');
      return true;
    });
    const executor = createExecutor({
      connected: true,
      send: send as unknown as ChildProcess['send'],
    });
    await executor.launchJob(runningJob);

    expect(() => executor.notifyDraining()).not.toThrow();
  });
});
