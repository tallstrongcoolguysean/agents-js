// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { ParticipantKind, type RemoteParticipant } from '@livekit/rtc-node';
import { describe, expect, it, vi } from 'vitest';
import { AgentSession, resolveRecordingOptions } from './agent_session.js';
import { AgentSessionEventTypes, createUserInputTranscribedEvent } from './events.js';
import { SpeechHandle } from './speech_handle.js';

type AgentSessionInternals = AgentSession & {
  _agentState: string;
  _aecWarmupTimer: NodeJS.Timeout | null;
  _userState: string;
  _setUserAwayTimer: () => void;
};

describe('AgentSession AEC warmup', () => {
  it.each([
    [ParticipantKind.SIP, {}, null],
    [ParticipantKind.SIP, { 'sip.ruleID': 'SDR_inbound' }, 3000],
    [ParticipantKind.STANDARD, {}, 3000],
  ] as const)(
    'uses the call type default for participant kind %s with attributes %o',
    (kind, attributes, expectedDuration) => {
      const session = new AgentSession({ vad: null });
      const participant = { info: { kind }, attributes } as RemoteParticipant;

      session._onRoomIOParticipantLinked(participant);

      expect(session.sessionOptions.aecWarmupDuration).toBe(expectedDuration);
      expect(session._aecWarmupRemaining).toBe(expectedDuration ?? 0);
    },
  );

  it.each([null, 0, 1500] as const)(
    'preserves an explicit AEC warmup duration of %s for outbound SIP',
    (duration) => {
      const session = new AgentSession({ vad: null, aecWarmupDuration: duration });
      const participant = {
        info: { kind: ParticipantKind.SIP },
        attributes: {},
      } as RemoteParticipant;

      session._onRoomIOParticipantLinked(participant);

      expect(session.sessionOptions.aecWarmupDuration).toBe(duration);
      expect(session._aecWarmupRemaining).toBe(duration ?? 0);
    },
  );

  it('cancels AEC warmup that already started for outbound SIP', () => {
    const session = new AgentSession({ vad: null });
    const internals = session as AgentSessionInternals;
    const timer = setTimeout(() => {}, 10_000);
    internals._aecWarmupTimer = timer;
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');
    const participant = {
      info: { kind: ParticipantKind.SIP },
      attributes: {},
    } as RemoteParticipant;

    session._onRoomIOParticipantLinked(participant);

    expect(clearTimeoutSpy).toHaveBeenCalledWith(timer);
    expect(internals._aecWarmupTimer).toBeNull();
    clearTimeoutSpy.mockRestore();
  });
});

describe('AgentSession.run', () => {
  it('forwards inputModality to generateReply', async () => {
    const session = new AgentSession();
    const generateReply = vi
      .spyOn(session, 'generateReply')
      .mockImplementation(() => SpeechHandle.create());

    session.run({ userInput: 'hello', inputModality: 'audio' });

    await vi.waitFor(() => {
      expect(generateReply).toHaveBeenCalledWith({
        userInput: 'hello',
        inputModality: 'audio',
      });
    });
  });
});

describe('AgentSession close lifecycle', () => {
  function createStartedSession() {
    const session = new AgentSession({ vad: null });
    const activity = {
      interrupt: vi.fn(() => ({ await: Promise.resolve() })),
      drain: vi.fn(async () => {}),
      currentSpeech: undefined,
      commitUserTurn: vi.fn(),
      detachAudioInput: vi.fn(),
      close: vi.fn(async () => {}),
    };
    const internals = session as unknown as {
      started: boolean;
      activity: typeof activity | undefined;
      closingTask: Promise<void> | null;
    };
    internals.started = true;
    internals.activity = activity;
    return { session, activity, internals };
  }

  it('deduplicates concurrent direct close calls', async () => {
    const { session, activity } = createStartedSession();

    await Promise.all([session.close(), session.close()]);

    expect(activity.interrupt).toHaveBeenCalledTimes(1);
    expect(activity.close).toHaveBeenCalledTimes(1);
  });

  it('does not gracefully drain during a forced close', async () => {
    const { session, activity } = createStartedSession();

    await session.close();

    expect(activity.interrupt).toHaveBeenCalledWith({ force: true });
    expect(activity.drain).not.toHaveBeenCalled();
  });

  it('preserves graceful draining when explicitly requested', async () => {
    const { session, activity, internals } = createStartedSession();

    session.shutdown({ drain: true });
    await internals.closingTask;

    expect(activity.interrupt).not.toHaveBeenCalled();
    expect(activity.drain).toHaveBeenCalledTimes(1);
  });

  it('cleans resources and releases primary designation after startup failure', async () => {
    const session = new AgentSession({ vad: null });
    const activity = {
      interrupt: vi.fn(() => ({ await: Promise.resolve() })),
      close: vi.fn(async () => {}),
    };
    const recorder = { close: vi.fn(async () => {}) };
    const sessionHost = { close: vi.fn(async () => {}) };
    const roomIO = { close: vi.fn(async () => {}) };
    const ctx = { _primaryAgentSession: session };
    const internals = session as unknown as {
      activity: typeof activity | undefined;
      _recorderIO: typeof recorder | undefined;
      sessionHost: typeof sessionHost | undefined;
      _roomIO: typeof roomIO | undefined;
      started: boolean;
      cleanupFailedStart: (context: typeof ctx) => Promise<void>;
    };
    internals.activity = activity;
    internals._recorderIO = recorder;
    internals.sessionHost = sessionHost;
    internals._roomIO = roomIO;

    await internals.cleanupFailedStart(ctx);

    expect(activity.interrupt).toHaveBeenCalledWith({ force: true });
    expect(activity.close).toHaveBeenCalledTimes(1);
    expect(recorder.close).toHaveBeenCalledTimes(1);
    expect(sessionHost.close).toHaveBeenCalledTimes(1);
    expect(roomIO.close).toHaveBeenCalledTimes(1);
    expect(ctx._primaryAgentSession).toBeUndefined();
    expect(internals.started).toBe(false);
  });
});

describe('resolveRecordingOptions', () => {
  it('treats a boolean as all-on or all-off', () => {
    expect(resolveRecordingOptions(true)).toEqual({
      audio: true,
      traces: true,
      logs: true,
      transcript: true,
      redaction: false,
    });
    expect(resolveRecordingOptions(false)).toEqual({
      audio: false,
      traces: false,
      logs: false,
      transcript: false,
      redaction: false,
    });
  });

  it('defaults omitted keys to true when given a partial object', () => {
    expect(resolveRecordingOptions({ audio: false })).toEqual({
      audio: false,
      traces: true,
      logs: true,
      transcript: true,
      redaction: false,
    });

    expect(resolveRecordingOptions({ redaction: true })).toEqual({
      audio: true,
      traces: true,
      logs: true,
      transcript: true,
      redaction: true,
    });

    // The granular form from the docs: keep audio, drop everything else.
    expect(
      resolveRecordingOptions({
        audio: true,
        traces: false,
        logs: false,
        transcript: false,
        redaction: true,
      }),
    ).toEqual({
      audio: true,
      traces: false,
      logs: false,
      transcript: false,
      redaction: true,
    });
  });

  it('returns a fresh object so callers cannot corrupt the shared defaults', () => {
    const opts = resolveRecordingOptions(true);
    opts.audio = false;
    expect(resolveRecordingOptions(true).audio).toBe(true);
  });
});

describe('AgentSession recording state', () => {
  it('_enableRecording is true when any category is on and false when all are off', () => {
    const session = new AgentSession();
    // Defaults to all-off until start() resolves the record argument.
    expect(session._enableRecording).toBe(false);

    session._recordingOptions = resolveRecordingOptions({
      audio: false,
      traces: false,
      logs: true,
      transcript: false,
      redaction: false,
    });
    expect(session._enableRecording).toBe(true);

    session._recordingOptions = resolveRecordingOptions({
      audio: false,
      traces: false,
      logs: false,
      transcript: false,
      redaction: true,
    });
    expect(session._enableRecording).toBe(false);

    session._recordingOptions = resolveRecordingOptions(false);
    expect(session._enableRecording).toBe(false);
  });
});

describe('AgentSession user input transcription', () => {
  it('resets the away timer on final transcripts when not speaking', () => {
    const session = new AgentSession({ userAwayTimeout: 15 });
    const internals = session as AgentSessionInternals;

    internals._agentState = 'listening';
    internals._userState = 'listening';

    const finalTranscript = createUserInputTranscribedEvent({
      transcript: 'hello',
      isFinal: true,
    });
    const interimTranscript = createUserInputTranscribedEvent({
      transcript: 'hello',
      isFinal: false,
    });

    const setTimer = vi.spyOn(internals, '_setUserAwayTimer').mockImplementation(() => {});
    session.emit(AgentSessionEventTypes.UserInputTranscribed, finalTranscript);
    expect(setTimer).toHaveBeenCalledOnce();
    expect(session.userState).toBe('listening');
    setTimer.mockRestore();

    const setTimerForInterim = vi
      .spyOn(internals, '_setUserAwayTimer')
      .mockImplementation(() => {});
    session.emit(AgentSessionEventTypes.UserInputTranscribed, interimTranscript);
    expect(setTimerForInterim).not.toHaveBeenCalled();
    setTimerForInterim.mockRestore();

    internals._userState = 'speaking';
    const setTimerWhileSpeaking = vi
      .spyOn(internals, '_setUserAwayTimer')
      .mockImplementation(() => {});
    session.emit(AgentSessionEventTypes.UserInputTranscribed, finalTranscript);
    expect(setTimerWhileSpeaking).not.toHaveBeenCalled();
    setTimerWhileSpeaking.mockRestore();
  });
});
