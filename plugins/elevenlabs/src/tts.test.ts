// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { tts } from '@livekit/agents';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import { type WebSocket, WebSocketServer } from 'ws';
import { TTS, type TTSOptions, type VoiceSettings } from './tts.js';

async function startWebSocketServer() {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(wss, 'listening');
  const address = wss.address() as AddressInfo;
  return { wss, baseURL: `http://127.0.0.1:${address.port}` };
}

async function closeWebSocketServer(wss: WebSocketServer): Promise<void> {
  for (const client of wss.clients) {
    client.close();
  }
  await new Promise<void>((resolve) => wss.close(() => resolve()));
}

async function waitUntil(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('timed out waiting for condition');
}

async function waitFor<T>(promise: Promise<T>, timeoutMs = 1000): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error('timed out waiting for promise')), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function captureStreamInit(opts: {
  chunkLengthSchedule?: number[];
  autoMode?: boolean;
  voiceSettings?: VoiceSettings;
}) {
  const { wss, baseURL } = await startWebSocketServer();
  const messages: Record<string, unknown>[] = [];
  let requestUrl = '';

  wss.on('connection', (ws, req) => {
    requestUrl = req.url ?? '';
    ws.on('message', (raw) => {
      const message = JSON.parse(raw.toString()) as Record<string, unknown>;
      messages.push(message);

      if (messages.length >= 2) {
        ws.send(JSON.stringify({ contextId: messages[0]?.context_id, isFinal: true }));
      }
    });
  });

  const elevenlabs = new TTS({
    apiKey: 'test-key',
    baseURL,
    chunkLengthSchedule: opts.chunkLengthSchedule,
    autoMode: opts.autoMode,
    voiceSettings: opts.voiceSettings,
  });
  const stream = elevenlabs.stream();

  try {
    stream.pushText('hello world.');
    stream.endInput();
    await waitUntil(() => messages.length >= 2);

    return {
      initPacket: messages[0]!,
      requestUrl,
    };
  } finally {
    stream.close();
    await elevenlabs.close();
    await closeWebSocketServer(wss);
  }
}

async function synthesizeWithMessages(
  sendResponses: (ws: WebSocket, messages: Record<string, unknown>[]) => void,
) {
  const { wss, baseURL } = await startWebSocketServer();
  const messages: Record<string, unknown>[] = [];

  wss.on('connection', (ws) => {
    ws.on('message', (raw) => {
      const message = JSON.parse(raw.toString()) as Record<string, unknown>;
      messages.push(message);
      sendResponses(ws, messages);
    });
  });

  const elevenlabs = new TTS({
    apiKey: 'test-key',
    baseURL,
  });
  const stream = elevenlabs.stream();
  const events: unknown[] = [];
  const outputTask = (async () => {
    for await (const event of stream) {
      events.push(event);
    }
  })();

  try {
    stream.pushText('hello world.');
    stream.endInput();
    await waitFor(outputTask);

    return { messages, events };
  } finally {
    stream.close();
    await elevenlabs.close();
    await closeWebSocketServer(wss);
  }
}

const hasElevenlabsConfig = Boolean(process.env.ELEVEN_API_KEY && process.env.OPENAI_API_KEY);
const hasElevenlabsTTSConfig = Boolean(process.env.ELEVEN_API_KEY);

if (hasElevenlabsTTSConfig) {
  describe('ElevenLabs TTS integration', () => {
    it('receives audio for a multi-sentence streaming utterance', async () => {
      const elevenlabs = new TTS({
        autoMode: true,
      });
      const stream = elevenlabs.stream();
      const events: unknown[] = [];
      const outputTask = (async () => {
        for await (const event of stream) {
          events.push(event);
        }
      })();

      try {
        stream.pushText('Hello.');
        stream.flush();
        stream.pushText('This is a streaming synthesis check.');
        stream.endInput();
        await waitFor(outputTask, 15000);

        expect(events.length).toBeGreaterThan(0);
      } finally {
        stream.close();
        await elevenlabs.close();
      }
    }, 20000);
  });
} else {
  describe('ElevenLabs TTS integration', () => {
    it.skip('requires ELEVEN_API_KEY', () => {});
  });
}

if (hasElevenlabsConfig) {
  describe('ElevenLabs', () => {
    it('runs the shared TTS integration tests', async () => {
      const openaiPackage = '@livekit/agents-plugin-openai';
      const testPackage = '@livekit/agents-plugins-test';
      const [{ STT }, { tts }] = await Promise.all([
        import(/* @vite-ignore */ openaiPackage),
        import(/* @vite-ignore */ testPackage),
      ]);

      await tts(new TTS(), new STT());
    });
  });
} else {
  describe('ElevenLabs', () => {
    it.skip('requires ELEVEN_API_KEY and OPENAI_API_KEY', () => {});
  });
}

describe('ElevenLabs TTS options', () => {
  it('includes chunk length schedule in the WebSocket init packet', async () => {
    const { initPacket, requestUrl } = await captureStreamInit({
      chunkLengthSchedule: [80, 120],
    });

    expect(initPacket.generation_config).toEqual({ chunk_length_schedule: [80, 120] });
    expect(new URL(`ws://127.0.0.1${requestUrl}`).searchParams.get('auto_mode')).toBe('false');
  });

  it('omits generation config when chunk length schedule is unset', async () => {
    const { initPacket, requestUrl } = await captureStreamInit({});

    expect(initPacket).not.toHaveProperty('generation_config');
    expect(new URL(`ws://127.0.0.1${requestUrl}`).searchParams.get('auto_mode')).toBe('true');
  });

  it('omits voice settings when they are not configured', async () => {
    const { initPacket } = await captureStreamInit({});

    expect(initPacket).not.toHaveProperty('voice_settings');
  });

  it('includes configured voice settings in the context init packet', async () => {
    const { initPacket } = await captureStreamInit({
      voiceSettings: { stability: 0.5, similarity_boost: 0.75 },
    });

    expect(initPacket.voice_settings).toEqual({ stability: 0.5, similarity_boost: 0.75 });
  });

  it('respects explicit autoMode with chunk length schedule', async () => {
    const { requestUrl } = await captureStreamInit({
      chunkLengthSchedule: [80, 120],
      autoMode: true,
    });

    expect(new URL(`ws://127.0.0.1${requestUrl}`).searchParams.get('auto_mode')).toBe('true');
  });
});

describe('ElevenLabs TTS HTTP streaming', () => {
  const audio = Buffer.alloc(4410);

  it('streams independent sentence requests without aligned transcript coupling', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(audio, {
        status: 200,
        headers: { 'Content-Type': 'audio/pcm' },
      }),
    );
    const elevenlabs = new TTS({
      apiKey: 'test-key',
      streamingTransport: 'http',
      continueOnError: true,
    });
    const stream = elevenlabs.stream();
    const events: unknown[] = [];

    try {
      stream.pushText('First sentence.');
      stream.flush();
      stream.pushText('Second sentence.');
      stream.endInput();
      for await (const event of stream) {
        events.push(event);
      }

      expect(events.length).toBeGreaterThan(0);
      expect(elevenlabs.capabilities.streaming).toBe(true);
      expect(elevenlabs.capabilities.alignedTranscript).toBe(false);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      stream.close();
      await elevenlabs.close();
      fetchMock.mockRestore();
    }
  });

  it('finishes after a recoverable sentence failure', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('provider unavailable', { status: 503 }));
    const elevenlabs = new TTS({
      apiKey: 'test-key',
      streamingTransport: 'http',
      continueOnError: true,
    });
    const errors: { recoverable: boolean }[] = [];
    elevenlabs.on('error', (event) => errors.push(event));
    const stream = elevenlabs.stream();
    const events: unknown[] = [];

    try {
      stream.pushText('This text turn must survive.');
      stream.endInput();
      for await (const event of stream) {
        if (typeof event !== 'symbol') {
          events.push(event);
        }
      }

      expect(events).toHaveLength(0);
      expect(errors).toHaveLength(1);
      expect(errors[0]?.recoverable).toBe(true);
    } finally {
      stream.close();
      await elevenlabs.close();
      fetchMock.mockRestore();
    }
  });

  it('aborts only the active HTTP request when interrupted', async () => {
    let requestAborted = false;
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(
      async (_input, init) =>
        await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            'abort',
            () => {
              requestAborted = true;
              reject(new DOMException('interrupted', 'AbortError'));
            },
            { once: true },
          );
        }),
    );
    const elevenlabs = new TTS({
      apiKey: 'test-key',
      streamingTransport: 'http',
      continueOnError: true,
    });
    const stream = elevenlabs.stream();
    const outputTask = (async () => {
      for await (const _event of stream) {
        // Interrupted synthesis must not emit late frames.
      }
    })();

    try {
      stream.pushText('This sentence will be interrupted.');
      stream.endInput();
      await new Promise((resolve) => setTimeout(resolve, 0));
      stream.close();
      await outputTask;

      expect(requestAborted).toBe(true);
    } finally {
      stream.close();
      await elevenlabs.close();
      fetchMock.mockRestore();
    }
  });
});

describe('ElevenLabs TTS websocket', () => {
  const audio = Buffer.alloc(4410).toString('base64');

  it('closes the shared WebSocket with a normal close code', async () => {
    const { wss, baseURL } = await startWebSocketServer();
    let resolveCloseCode: ((code: number) => void) | undefined;
    const closeCode = new Promise<number>((resolve) => {
      resolveCloseCode = resolve;
    });

    wss.on('connection', (ws) => {
      ws.on('close', (code) => resolveCloseCode?.(code));
      ws.on('message', (raw) => {
        const message = JSON.parse(raw.toString()) as Record<string, unknown>;
        if (message.text === ' ' || !message.text) {
          return;
        }
        ws.send(JSON.stringify({ context_id: message.context_id, audio, isFinal: true }));
      });
    });

    const elevenlabs = new TTS({ apiKey: 'test-key', baseURL });
    const stream = elevenlabs.stream();
    const outputTask = (async () => {
      for await (const _event of stream) {
        // Drain synthesized audio before closing the provider.
      }
    })();

    try {
      stream.pushText('hello world.');
      stream.endInput();
      await waitFor(outputTask);
      await elevenlabs.close();

      expect(await waitFor(closeCode)).toBe(1000);
    } finally {
      stream.close();
      await elevenlabs.close();
      await closeWebSocketServer(wss);
    }
  });

  it('accepts snake-case context IDs', async () => {
    const { events } = await synthesizeWithMessages((ws, messages) => {
      if (messages.length === 2) {
        ws.send(
          JSON.stringify({
            context_id: messages[0]?.context_id,
            audio,
            isFinal: true,
          }),
        );
      }
    });

    expect(events.length).toBeGreaterThan(0);
  });

  it('still accepts camel-case context IDs', async () => {
    const { events } = await synthesizeWithMessages((ws, messages) => {
      if (messages.length === 2) {
        ws.send(
          JSON.stringify({
            contextId: messages[0]?.context_id,
            audio,
            isFinal: true,
          }),
        );
      }
    });

    expect(events.length).toBeGreaterThan(0);
  });

  it('keeps the context alive when the final packet arrives before audio', async () => {
    const { events } = await synthesizeWithMessages((ws, messages) => {
      if (messages.length === 2) {
        const contextId = messages[0]?.context_id;
        ws.send(JSON.stringify({ context_id: contextId, isFinal: true }));
        ws.send(JSON.stringify({ context_id: contextId, audio }));
      }
    });

    expect(events.length).toBeGreaterThan(0);
  });

  it('ignores flush_done for active contexts', async () => {
    const { events } = await synthesizeWithMessages((ws, messages) => {
      if (messages.length === 2) {
        ws.send(
          JSON.stringify({
            type: 'flush_done',
            context_id: messages[0]?.context_id,
            status_code: 206,
            done: false,
            data: '',
            flush_done: true,
          }),
        );
        ws.send(
          JSON.stringify({
            context_id: messages[0]?.context_id,
            audio,
            isFinal: true,
          }),
        );
      }
    });

    expect(events.length).toBeGreaterThan(0);
  });

  it('ignores flush_done for inactive contexts', async () => {
    const { events } = await synthesizeWithMessages((ws, messages) => {
      if (messages.length === 2) {
        ws.send(
          JSON.stringify({
            type: 'flush_done',
            context_id: 'already_closed_context',
            status_code: 206,
            done: false,
            data: '',
            flush_done: true,
          }),
        );
        ws.send(
          JSON.stringify({
            context_id: messages[0]?.context_id,
            audio,
            isFinal: true,
          }),
        );
      }
    });

    expect(events.length).toBeGreaterThan(0);
  });
});

describe('ElevenLabs TTS stall watchdog', () => {
  const audio = Buffer.alloc(4410).toString('base64');

  async function synthesizeWithConnOptions(
    connOptions: { maxRetry: number; retryIntervalMs: number; timeoutMs: number },
    sendResponses: (ws: WebSocket, message: Record<string, unknown>, initCount: number) => void,
  ) {
    const { wss, baseURL } = await startWebSocketServer();
    const initPackets: Record<string, unknown>[] = [];
    let connections = 0;

    wss.on('connection', (ws) => {
      connections += 1;
      ws.on('message', (raw) => {
        const message = JSON.parse(raw.toString()) as Record<string, unknown>;
        if (message.text === ' ') {
          initPackets.push(message);
        }
        sendResponses(ws, message, initPackets.length);
      });
    });

    const elevenlabs = new TTS({ apiKey: 'test-key', baseURL });
    const events: unknown[] = [];
    const errors: Error[] = [];

    // The base class reports a failed attempt as a `tts_error` on the TTS itself, not on
    // the stream, and without a listener Node turns it into ERR_UNHANDLED_ERROR.
    elevenlabs.on('error', (event: { error: Error }) => {
      errors.push(event.error);
    });

    const stream = elevenlabs.stream({ connOptions });
    const outputTask = (async () => {
      for await (const event of stream) {
        events.push(event);
      }
    })();

    try {
      stream.pushText('hello world.');
      stream.endInput();
      await waitFor(outputTask, 5000);

      return { initPackets, events, errors, connections };
    } finally {
      stream.close();
      await elevenlabs.close();
      await closeWebSocketServer(wss);
    }
  }

  it('fails the attempt when the final message never arrives', async () => {
    const { events, errors } = await synthesizeWithConnOptions(
      { maxRetry: 0, retryIntervalMs: 0, timeoutMs: 150 },
      () => {
        // Accept the text and go silent, the way a wedged ElevenLabs context does.
      },
    );

    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toContain('no data for 150ms');
    expect(events).toHaveLength(0);
  });

  it('does not emit a partial segment from a stalled attempt', async () => {
    const { events, errors } = await synthesizeWithConnOptions(
      { maxRetry: 0, retryIntervalMs: 0, timeoutMs: 150 },
      (ws, message) => {
        // Audio arrives, then the context goes silent without ever sending isFinal.
        if (message.text !== ' ' && message.text) {
          ws.send(JSON.stringify({ context_id: message.context_id, audio }));
        }
      },
    );

    expect(errors).toHaveLength(1);
    expect(events).toHaveLength(0);
  });

  it('replays the utterance on a fresh socket after an abnormal close', async () => {
    let attempts = 0;
    const { connections, events, errors } = await synthesizeWithConnOptions(
      { maxRetry: 1, retryIntervalMs: 0, timeoutMs: 1000 },
      (ws, message) => {
        if (message.text === ' ' || !message.text) {
          return;
        }

        attempts += 1;
        if (attempts === 1) {
          ws.terminate();
          return;
        }

        ws.send(JSON.stringify({ context_id: message.context_id, audio, isFinal: true }));
      },
    );

    expect(connections).toBe(2);
    expect(attempts).toBe(2);
    expect(events.length).toBeGreaterThan(0);
    expect(errors).toHaveLength(0);
  });

  it('replays the utterance on a fresh socket after a protocol violation', async () => {
    let attempts = 0;
    const { connections, events, errors } = await synthesizeWithConnOptions(
      { maxRetry: 1, retryIntervalMs: 0, timeoutMs: 1000 },
      (ws, message) => {
        if (message.text === ' ' || !message.text) {
          return;
        }

        attempts += 1;
        if (attempts === 1) {
          ws.send(
            JSON.stringify({
              context_id: message.context_id,
              error: 'protocol_violation',
              message:
                'voice_settings field must be provided in the first message and then either be not provided or not change.',
            }),
          );
          return;
        }

        ws.send(JSON.stringify({ context_id: message.context_id, audio, isFinal: true }));
      },
    );

    expect(connections).toBe(2);
    expect(attempts).toBe(2);
    expect(events.length).toBeGreaterThan(0);
    expect(errors).toHaveLength(0);
  });

  it('replays the utterance on a fresh socket after a stall', async () => {
    let attempts = 0;
    const { initPackets, connections, events, errors } = await synthesizeWithConnOptions(
      { maxRetry: 1, retryIntervalMs: 0, timeoutMs: 150 },
      (ws, message) => {
        if (message.text === ' ' || !message.text) {
          return;
        }

        attempts += 1;
        if (attempts === 2) {
          ws.send(JSON.stringify({ context_id: message.context_id, audio, isFinal: true }));
        }
      },
    );

    expect(connections).toBe(2);
    expect(initPackets).toHaveLength(2);
    expect(attempts).toBe(2);
    expect(events.length).toBeGreaterThan(0);
    expect(errors).toHaveLength(0);
  });

  it('retires the silent connection so the next utterance gets a fresh socket', async () => {
    const { wss, baseURL } = await startWebSocketServer();
    const connOptions = { maxRetry: 0, retryIntervalMs: 0, timeoutMs: 150 };
    let connections = 0;
    let answering = false;

    wss.on('connection', (ws) => {
      connections += 1;
      ws.on('message', (raw) => {
        const message = JSON.parse(raw.toString()) as Record<string, unknown>;
        if (!answering || message.text === ' ' || !message.text) {
          return;
        }
        ws.send(JSON.stringify({ context_id: message.context_id, audio, isFinal: true }));
      });
    });

    const elevenlabs = new TTS({ apiKey: 'test-key', baseURL });
    const errors: Error[] = [];
    elevenlabs.on('error', (event: { error: Error }) => {
      errors.push(event.error);
    });

    const drain = async (stream: ReturnType<TTS['stream']>, text: string) => {
      const events: unknown[] = [];
      const task = (async () => {
        for await (const event of stream) {
          events.push(event);
        }
      })();
      stream.pushText(text);
      stream.endInput();
      await waitFor(task, 5000);
      stream.close();

      return events;
    };

    try {
      const stalledEvents = await drain(elevenlabs.stream({ connOptions }), 'hello world.');
      expect(stalledEvents).toHaveLength(0);
      expect(errors).toHaveLength(1);
      expect(connections).toBe(1);

      // The utterance after a stall must not land on the socket that stopped answering.
      answering = true;
      const recoveredEvents = await drain(elevenlabs.stream({ connOptions }), 'hello again.');

      expect(connections).toBe(2);
      expect(recoveredEvents.length).toBeGreaterThan(0);
      expect(errors).toHaveLength(1);
    } finally {
      await elevenlabs.close();
      await closeWebSocketServer(wss);
    }
  });

  it('leaves a healthy stream untouched', async () => {
    const { events, errors } = await synthesizeWithConnOptions(
      { maxRetry: 0, retryIntervalMs: 0, timeoutMs: 1000 },
      (ws, message) => {
        if (message.text !== ' ' && message.text) {
          ws.send(JSON.stringify({ context_id: message.context_id, audio, isFinal: true }));
        }
      },
    );

    expect(errors).toHaveLength(0);
    expect(events.length).toBeGreaterThan(0);
  });
});

describe('ElevenLabs TTS abandoned utterance', () => {
  // Two 100 ms frames, so the first one plays before the provider goes quiet.
  const audio = Buffer.alloc(8820).toString('base64');
  const connOptions = { maxRetry: 0, retryIntervalMs: 0, timeoutMs: 150 };
  const utterance = 'The waste backup gets more serious. Then the kidneys struggle to keep up.';

  function alignment(text: string) {
    const chars = [...text];
    return {
      chars,
      charStartTimesMs: chars.map((_, i) => i * 10),
      charDurationsMs: chars.map(() => 10),
    };
  }

  /**
   * The provider voices `spoken` for the first sentence it gets, then never answers again.
   * `spoken: null` sends that audio without alignment. ElevenLabs HTTP answers with audio
   * unless `respond` says otherwise.
   */
  async function abandonAfter(
    spoken: string | null,
    drive: (
      stream: tts.SynthesizeStream,
      wait: { heard: () => Promise<void>; stalled: () => Promise<void> },
    ) => Promise<void>,
    opts: {
      tailFallback?: TTSOptions['tailFallback'];
      respond?: (call: number, signal?: AbortSignal | null) => Promise<Response | undefined>;
      /** Speak through LiveKit's FallbackAdapter, with an HTTP instance behind the socket. */
      fallbackAdapter?: boolean;
    } = {},
  ) {
    const { wss, baseURL } = await startWebSocketServer();
    let answered = false;
    wss.on('connection', (ws) => {
      ws.on('message', (raw) => {
        const message = JSON.parse(raw.toString()) as Record<string, unknown>;
        if (answered || message.text === ' ' || !message.text) return;
        answered = true;
        ws.send(
          JSON.stringify({
            context_id: message.context_id,
            audio,
            ...(spoken === null
              ? {}
              : { alignment: alignment(spoken), normalizedAlignment: alignment(spoken) }),
          }),
        );
      });
    });

    const requests: { url: string; apiKey: string | null; body: Record<string, unknown> }[] = [];
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      requests.push({
        url: String(input),
        apiKey: new Headers(init?.headers).get('xi-api-key'),
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      });
      return (
        (await opts.respond?.(requests.length, init?.signal)) ??
        new Response(Buffer.alloc(8820), { status: 200, headers: { 'Content-Type': 'audio/pcm' } })
      );
    });

    const websocket = new TTS({ apiKey: 'test-key', baseURL, tailFallback: opts.tailFallback });
    const source = opts.fallbackAdapter
      ? new tts.FallbackAdapter({
          ttsInstances: [
            websocket,
            new TTS({ apiKey: 'test-key', streamingTransport: 'http', continueOnError: true }),
          ],
          maxRetryPerTTS: 0,
        })
      : websocket;
    const errors: { error: Error; recoverable: boolean }[] = [];
    source.on('error', (event: { error: Error; recoverable: boolean }) => errors.push(event));
    const stream = source.stream({ connOptions });
    const events: tts.SynthesizedAudio[] = [];
    const outputTask = (async () => {
      for await (const event of stream) {
        if (event !== tts.SynthesizeStream.END_OF_STREAM) events.push(event);
      }
    })();

    try {
      await drive(stream, {
        heard: () => waitUntil(() => events.length > 0, 2000),
        stalled: () => waitUntil(() => errors.length > 0, 2000),
      });
      await waitFor(outputTask, 5000);
      const transcript = events
        .flatMap((event) => event.timedTranscripts ?? [])
        .map((word) => word.text)
        .join('')
        .trim();

      return { requests, events, errors, transcript };
    } finally {
      stream.close();
      await source.close();
      await closeWebSocketServer(wss);
      fetchMock.mockRestore();
    }
  }

  const speakAll = async (stream: tts.SynthesizeStream) => {
    stream.pushText(utterance);
    stream.endInput();
  };
  const spokenOverHttp = (requests: { body: Record<string, unknown> }[]) =>
    requests.map((request) => request.body.text).join(' ');

  it('finishes over HTTP from the first word without audio', async () => {
    const { requests, events, errors, transcript } = await abandonAfter(
      'The waste backup gets more ',
      speakAll,
      { tailFallback: { apiKey: 'http-key', baseURL: 'https://http.example.test/v1' } },
    );

    expect(errors).toHaveLength(1);
    expect(errors[0]!.recoverable).toBe(true);
    expect(errors[0]!.error.message).toContain('no data for 150ms');
    expect(spokenOverHttp(requests)).toBe('serious. Then the kidneys struggle to keep up.');
    expect(requests[0]!.url.startsWith('https://http.example.test/v1/text-to-speech/')).toBe(true);
    expect(requests[0]!.apiKey).toBe('http-key');
    expect(requests[0]!.body.previous_text).toBe('The waste backup gets more ');
    expect(transcript).toBe(utterance);
    expect(events.at(-1)!.final).toBe(true);
    expect(events.slice(0, -1).every((event) => !event.final)).toBe(true);
  });

  it('sends a tail with its own key to the ElevenLabs API, not the WebSocket proxy', async () => {
    const { requests } = await abandonAfter('The waste backup gets more ', speakAll, {
      tailFallback: { apiKey: 'http-key' },
    });

    expect(requests[0]!.url.startsWith('https://api.elevenlabs.io/v1/text-to-speech/')).toBe(true);
    expect(requests[0]!.apiKey).toBe('http-key');
  });

  it('speaks a word cut in half again from its start', async () => {
    const { requests, transcript } = await abandonAfter('The waste backup gets mo', speakAll);

    expect(spokenOverHttp(requests)).toBe('more serious. Then the kidneys struggle to keep up.');
    expect(transcript).toBe(utterance);
  });

  it('keeps taking text the LLM streams after the provider stalls', async () => {
    const { requests, transcript } = await abandonAfter(
      'The waste backup gets more ',
      async (stream, { heard, stalled }) => {
        stream.pushText('The waste backup gets more serious.');
        stream.flush();
        await heard();
        // The provider never answers this sentence, which is what stalls the attempt.
        stream.pushText(' Then the kidneys struggle to keep up.');
        stream.flush();
        await stalled();
        stream.pushText(' Fluid starts to build.');
        stream.endInput();
      },
    );

    expect(spokenOverHttp(requests).startsWith('serious.')).toBe(true);
    expect(spokenOverHttp(requests)).toContain('Fluid starts to build.');
    expect(spokenOverHttp(requests)).not.toContain('gets more');
    expect(transcript).toBe(`${utterance} Fluid starts to build.`);
  });

  it('plays out the received audio when only the final message is missing', async () => {
    const { requests, events, errors, transcript } = await abandonAfter(utterance, speakAll);

    expect(errors).toHaveLength(1);
    expect(requests).toHaveLength(0);
    // Including the last word, which the aligner holds back until the final message.
    expect(transcript).toBe(utterance);
    expect(events.at(-1)!.final).toBe(true);
  });

  it('loses only the sentence whose HTTP request fails', async () => {
    const { requests, events, errors, transcript } = await abandonAfter(
      'The waste backup gets more serious. ',
      async (stream) => {
        stream.pushText(`${utterance} Fluid starts to build up in the body.`);
        stream.endInput();
      },
      {
        respond: async (call) =>
          call === 1 ? new Response('provider unavailable', { status: 503 }) : undefined,
      },
    );

    expect(spokenOverHttp(requests)).toBe(
      'Then the kidneys struggle to keep up. Fluid starts to build up in the body.',
    );
    expect(errors.map((event) => event.recoverable)).toEqual([true, true]);
    expect(transcript).toBe(
      'The waste backup gets more serious. Fluid starts to build up in the body.',
    );
    expect(events.at(-1)!.final).toBe(true);
  });

  it('stops the HTTP tail when the listener interrupts', async () => {
    let requestStarted = false;
    let requestAborted = false;
    const { requests, events } = await abandonAfter(
      'The waste backup gets more ',
      async (stream, { stalled }) => {
        await speakAll(stream);
        await stalled();
        await waitUntil(() => requestStarted);
        stream.close();
      },
      {
        respond: (_call, signal) =>
          new Promise<Response>((_resolve, reject) => {
            requestStarted = true;
            signal?.addEventListener(
              'abort',
              () => {
                requestAborted = true;
                reject(new DOMException('interrupted', 'AbortError'));
              },
              { once: true },
            );
          }),
      },
    );

    expect(requests).toHaveLength(1);
    expect(requestAborted).toBe(true);
    expect(events.some((event) => event.final)).toBe(false);
  });

  it('finishes inside the FallbackAdapter instead of switching instances', async () => {
    const { requests, events, transcript } = await abandonAfter(
      'The waste backup gets more ',
      speakAll,
      { fallbackAdapter: true },
    );

    // The HTTP instance behind the socket would have re-synthesized the whole utterance.
    expect(spokenOverHttp(requests)).toBe('serious. Then the kidneys struggle to keep up.');
    expect(transcript).toBe(utterance);
    expect(events.at(-1)!.final).toBe(true);
  });

  it('ends the utterance at the failure when the tail fallback is off', async () => {
    const { requests, events, errors } = await abandonAfter(
      'The waste backup gets more ',
      speakAll,
      { tailFallback: false },
    );

    expect(requests).toHaveLength(0);
    expect(errors).toHaveLength(1);
    expect(events.length).toBeGreaterThan(0);
  });

  it('does not guess where to resume without alignment', async () => {
    const { requests, events, errors } = await abandonAfter(null, speakAll);

    expect(requests).toHaveLength(0);
    expect(errors).toHaveLength(1);
    expect(events.length).toBeGreaterThan(0);
  });
});
