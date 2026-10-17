// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { LocalAudioTrack, TrackPublishOptions, TrackSource } from '@livekit/rtc-node';
import { describe, expect, it, vi } from 'vitest';
import { Future } from '../../utils.js';
import { ParticipantAudioOutput } from './_output.js';

type CaptureFrameArg = Parameters<ParticipantAudioOutput['captureFrame']>[0];

const nextTick = () => new Promise<void>((resolve) => setImmediate(resolve));

describe('ParticipantAudioOutput waitForPlayoutTask', () => {
  it('resets tracked duration after non-interrupted playout', async () => {
    let resolvePlayout!: () => void;
    const waitForPlayout = new Promise<void>((resolve) => {
      resolvePlayout = resolve;
    });

    const output = Object.create(ParticipantAudioOutput.prototype) as ParticipantAudioOutput & {
      pushedDuration: number;
      interruptedFuture: Future<void>;
      firstFrameEmitted: boolean;
      audioSource: {
        waitForPlayout: () => Promise<void>;
        queuedDuration: number;
        clearQueue: () => void;
      };
      onPlaybackFinished: (event: { playbackPosition: number; interrupted: boolean }) => void;
      waitForPlayoutTask: (abortController: AbortController) => Promise<void>;
    };

    const onPlaybackFinished = vi.fn();
    output.pushedDuration = 1.0;
    output.interruptedFuture = new Future<void>();
    output.firstFrameEmitted = true;
    output.onPlaybackFinished = onPlaybackFinished;
    output.audioSource = {
      waitForPlayout: () => waitForPlayout,
      queuedDuration: 0,
      clearQueue: vi.fn(),
    };

    const task = output.waitForPlayoutTask(new AbortController());

    resolvePlayout();
    await task;

    expect(output.pushedDuration).toBe(0);
    expect(onPlaybackFinished).toHaveBeenCalledWith({
      playbackPosition: 1.0,
      interrupted: false,
    });
  });

  it('resets duration to queue state when interrupted flush clears overlap', async () => {
    let resolvePlayout!: () => void;
    const waitForPlayout = new Promise<void>((resolve) => {
      resolvePlayout = resolve;
    });

    const output = Object.create(ParticipantAudioOutput.prototype) as ParticipantAudioOutput & {
      pushedDuration: number;
      interruptedFuture: Future<void>;
      firstFrameEmitted: boolean;
      audioSource: {
        waitForPlayout: () => Promise<void>;
        queuedDuration: number;
        clearQueue: () => void;
      };
      onPlaybackFinished: (event: { playbackPosition: number; interrupted: boolean }) => void;
      waitForPlayoutTask: (abortController: AbortController) => Promise<void>;
    };

    const onPlaybackFinished = vi.fn();
    output.pushedDuration = 1.0;
    output.interruptedFuture = new Future<void>();
    output.firstFrameEmitted = true;
    output.onPlaybackFinished = onPlaybackFinished;
    output.audioSource = {
      waitForPlayout: () => waitForPlayout,
      queuedDuration: 500,
      clearQueue: vi.fn(() => {
        output.audioSource.queuedDuration = 0;
      }),
    };

    const task = output.waitForPlayoutTask(new AbortController());

    // Overlap from the next segment arrives before interruption.
    output.pushedDuration += 0.5;
    output.interruptedFuture.resolve();
    resolvePlayout();
    await task;

    // interrupted path clears queued overlap, so duration should not retain stale overlap time.
    expect(output.pushedDuration).toBe(0);
    expect(onPlaybackFinished).toHaveBeenCalledWith({
      playbackPosition: 0.5,
      interrupted: true,
    });
  });

  it('does not finish one segment twice when flush is called again before playout drains', async () => {
    let resolvePlayout!: () => void;
    const waitForPlayout = new Promise<void>((resolve) => {
      resolvePlayout = resolve;
    });

    const output = Object.create(ParticipantAudioOutput.prototype) as ParticipantAudioOutput & {
      pushedDuration: number;
      flushTask?: { done: boolean };
      flushPushedDuration?: number;
      interruptedFuture: Future<void>;
      firstFrameEmitted: boolean;
      audioSource: {
        waitForPlayout: () => Promise<void>;
        queuedDuration: number;
        clearQueue: () => void;
      };
      onPlaybackFinished: (event: { playbackPosition: number; interrupted: boolean }) => void;
      logger: {
        error: () => void;
      };
    };

    const onPlaybackFinished = vi.fn();
    output.pushedDuration = 1.0;
    output.interruptedFuture = new Future<void>();
    output.firstFrameEmitted = true;
    output.onPlaybackFinished = onPlaybackFinished;
    output.logger = {
      error: vi.fn(),
    };
    output.audioSource = {
      waitForPlayout: () => waitForPlayout,
      queuedDuration: 0,
      clearQueue: vi.fn(),
    };

    output.flush();
    await nextTick();

    output.flush();
    await nextTick();

    resolvePlayout();
    await nextTick();

    expect(onPlaybackFinished).toHaveBeenCalledTimes(1);
    expect(onPlaybackFinished).toHaveBeenCalledWith({
      playbackPosition: 1.0,
      interrupted: false,
    });
    expect(output.logger.error).not.toHaveBeenCalled();
  });
});

describe('ParticipantAudioOutput captureFrame segment accounting', () => {
  type TestOutput = ParticipantAudioOutput & {
    startedFuture: Future<void>;
    playbackEnabledFuture: Future<void>;
    interruptedFuture: Future<void>;
    segmentStarted: boolean;
    firstFrameEmitted: boolean;
    pushedDuration: number;
    _capturing: boolean;
    playbackSegmentsCount: number;
    playbackFinishedCount: number;
    playbackFinishedFuture: Future<void>;
    onPlaybackStarted: (createdAt: number) => void;
    audioSource: {
      clearQueue: () => void;
      captureFrame: (frame: CaptureFrameArg) => Promise<void>;
    };
  };

  const makeOutput = (opts: { paused: boolean }): TestOutput => {
    const output = Object.create(ParticipantAudioOutput.prototype) as TestOutput;
    output.startedFuture = new Future<void>();
    output.startedFuture.resolve();
    output.playbackEnabledFuture = new Future<void>();
    if (!opts.paused) output.playbackEnabledFuture.resolve();
    output.interruptedFuture = new Future<void>();
    output.segmentStarted = false;
    output.firstFrameEmitted = false;
    output.pushedDuration = 0;
    output._capturing = false;
    output.playbackSegmentsCount = 0;
    output.playbackFinishedCount = 0;
    output.playbackFinishedFuture = new Future<void>();
    output.onPlaybackStarted = vi.fn();
    output.audioSource = { clearQueue: vi.fn(), captureFrame: vi.fn(async () => {}) };
    return output;
  };

  const frame = () => ({ samplesPerChannel: 480, sampleRate: 24000 }) as unknown as CaptureFrameArg;

  it('does not strand the segment counter when a frame is interrupted while paused', async () => {
    const output = makeOutput({ paused: true });

    const capture = output.captureFrame(frame());
    output.interruptedFuture.resolve();
    await capture;

    expect(output.playbackSegmentsCount).toBe(0);
    expect(output.audioSource.captureFrame).not.toHaveBeenCalled();

    const result = await Promise.race([
      output.waitForPlayout().then(() => 'resolved' as const),
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 1000)),
    ]);
    expect(result).toBe('resolved');
  });

  for (const endSegment of ['flush', 'abandonOpenSegment'] as const) {
    it(`holds a paused frame of the segment after an interrupted one (${endSegment})`, async () => {
      const output = makeOutput({ paused: true });
      // The previous segment was interrupted, and then it ended.
      output.segmentStarted = true;
      output.interruptedFuture.resolve();
      output[endSegment]();

      let captured = false;
      const capture = output.captureFrame(frame()).then(() => {
        captured = true;
      });
      await nextTick();
      expect(captured).toBe(false);
      expect(output.audioSource.captureFrame).not.toHaveBeenCalled();

      output.resume();
      await capture;
      expect(output.audioSource.captureFrame).toHaveBeenCalledTimes(1);
      expect(output.playbackSegmentsCount).toBe(1);
    });
  }

  it('drops a paused frame when its own segment is interrupted', async () => {
    const output = makeOutput({ paused: false });
    await output.captureFrame(frame());

    output.pause();
    output.clearBuffer();
    await output.captureFrame(frame());

    expect(output.audioSource.captureFrame).toHaveBeenCalledTimes(1);
  });

  it('registers a segment on the normal non-paused path', async () => {
    const output = makeOutput({ paused: false });

    await output.captureFrame(frame());

    expect(output.playbackSegmentsCount).toBe(1);
    expect(output.audioSource.captureFrame).toHaveBeenCalledTimes(1);
    expect(output.pushedDuration).toBeGreaterThan(0);
  });

  it('emits playbackStarted once across pause and resume', async () => {
    const output = makeOutput({ paused: false });
    const audioFrame = frame();

    output.resume();
    for (let i = 0; i < 3; i++) {
      await output.captureFrame(audioFrame);
    }
    expect(output.onPlaybackStarted).toHaveBeenCalledTimes(1);

    output.pause();
    output.resume();
    for (let i = 0; i < 3; i++) {
      await output.captureFrame(audioFrame);
    }

    expect(output.onPlaybackStarted).toHaveBeenCalledTimes(1);
  });
});

describe('ParticipantAudioOutput publishTrack', () => {
  it('publishes with the configured trackPublishOptions', async () => {
    const trackPublishOptions = new TrackPublishOptions({
      source: TrackSource.SOURCE_MICROPHONE,
      dtx: false,
      red: false,
    });

    const output = Object.create(ParticipantAudioOutput.prototype) as ParticipantAudioOutput & {
      options: { trackPublishOptions: TrackPublishOptions };
      audioSource: unknown;
      startedFuture: Future<void>;
      room: unknown;
      publishTrack: (signal: AbortSignal) => Promise<void>;
    };

    const fakeTrack = {} as LocalAudioTrack;
    const createAudioTrack = vi
      .spyOn(LocalAudioTrack, 'createAudioTrack')
      .mockReturnValue(fakeTrack);
    const publishTrack = vi.fn(async () => ({ waitForSubscription: async () => {} }));

    output.options = { trackPublishOptions };
    output.audioSource = {};
    output.startedFuture = new Future<void>();
    output.room = { localParticipant: { publishTrack } };

    try {
      await output.publishTrack(new AbortController().signal);
    } finally {
      createAudioTrack.mockRestore();
    }

    expect(publishTrack).toHaveBeenCalledWith(fakeTrack, trackPublishOptions);
    expect(output.startedFuture.done).toBe(true);
  });
});

describe('ParticipantAudioOutput reply after an interrupted reply', () => {
  type TestOutput = ParticipantAudioOutput & {
    startedFuture: Future<void>;
    playbackEnabledFuture: Future<void>;
    interruptedFuture: Future<void>;
    segmentStarted: boolean;
    firstFrameEmitted: boolean;
    pushedDuration: number;
    flushTask?: { result: Promise<void> };
    _capturing: boolean;
    playbackSegmentsCount: number;
    playbackFinishedCount: number;
    playbackFinishedFuture: Future<void>;
    onPlaybackStarted: (createdAt: number) => void;
    onPlaybackFinished: (event: { playbackPosition: number; interrupted: boolean }) => void;
    audioSource: {
      queuedDuration: number;
      captureFrame: (frame: CaptureFrameArg) => Promise<void>;
      clearQueue: () => void;
      waitForPlayout: () => Promise<void>;
    };
  };

  const frame = () => ({ samplesPerChannel: 480, sampleRate: 24000 }) as unknown as CaptureFrameArg;

  // Playout waits for queued audio, and clearing the queue ends the wait, like rtc-node's source.
  const makeOutput = () => {
    let playout: Promise<void> | undefined;
    let endPlayout: (() => void) | undefined;
    const playOut = () => {
      endPlayout?.();
      playout = endPlayout = undefined;
    };
    const resolved = new Future<void>();
    resolved.resolve();
    const playing = new Future<void>();
    playing.resolve();
    const output = Object.create(ParticipantAudioOutput.prototype) as TestOutput;
    Object.assign(output, {
      startedFuture: resolved,
      playbackEnabledFuture: playing,
      interruptedFuture: new Future<void>(),
      segmentStarted: false,
      firstFrameEmitted: false,
      pushedDuration: 0,
      _capturing: false,
      playbackSegmentsCount: 0,
      playbackFinishedCount: 0,
      playbackFinishedFuture: new Future<void>(),
      onPlaybackStarted: vi.fn(),
      onPlaybackFinished: vi.fn(),
      audioSource: {
        queuedDuration: 0,
        captureFrame: vi.fn(async () => {
          playout ??= new Promise<void>((resolve) => {
            endPlayout = resolve;
          });
        }),
        clearQueue: vi.fn(playOut),
        waitForPlayout: () => playout ?? Promise.resolve(),
      },
    });
    const lastFinish = () => vi.mocked(output.onPlaybackFinished).mock.calls.at(-1)?.[0];
    return { output, playOut, lastFinish };
  };

  // The student talks over reply A and really interrupts it. The calls follow forwardAudio
  // (generation.ts) and the agent's interruption: abort forwarding, then clear the buffer.
  const interruptedReply = async (output: TestOutput) => {
    output.resume();
    await output.captureFrame(frame());
    output.pause();
    const held = output.captureFrame(frame());
    output.clearBuffer();
    await held;
    output.flush();
    output.clearBuffer();
    await output.flushTask!.result;
  };

  // Reply B plays, then the student starts talking and the agent pauses it.
  const pausedReply = async (output: TestOutput) => {
    output.resume();
    await output.captureFrame(frame());
    output.pause();
    let captured = false;
    const held = output.captureFrame(frame()).then(() => {
      captured = true;
    });
    await nextTick();
    return { held, captured: () => captured };
  };

  it('reports the next reply interrupted when the student interrupts it while paused', async () => {
    const { output, lastFinish } = makeOutput();
    await interruptedReply(output);
    expect(lastFinish()).toMatchObject({ interrupted: true });

    const reply = await pausedReply(output);
    // The pause holds the frame. Dropping it let forwarding finish as if the reply played out.
    expect(reply.captured()).toBe(false);

    output.clearBuffer();
    await reply.held;
    output.flush();
    output.clearBuffer();
    await output.flushTask!.result;

    expect(lastFinish()).toMatchObject({ interrupted: true });
    expect(output.audioSource.captureFrame).toHaveBeenCalledTimes(2);
  });

  it('plays the rest of the next reply after a false interruption', async () => {
    const { output, playOut, lastFinish } = makeOutput();
    await interruptedReply(output);

    const reply = await pausedReply(output);
    expect(reply.captured()).toBe(false);

    output.resume();
    await reply.held;
    expect(output.audioSource.captureFrame).toHaveBeenCalledTimes(3);
    output.flush();
    playOut();
    await output.flushTask!.result;

    expect(lastFinish()).toMatchObject({ interrupted: false });
  });
});
