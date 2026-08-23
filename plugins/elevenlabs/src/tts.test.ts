// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { type WebSocket, WebSocketServer } from 'ws';
import { TTS } from './tts.js';

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

async function captureStreamInit(opts: { chunkLengthSchedule?: number[]; autoMode?: boolean }) {
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

  it('respects explicit autoMode with chunk length schedule', async () => {
    const { requestUrl } = await captureStreamInit({
      chunkLengthSchedule: [80, 120],
      autoMode: true,
    });

    expect(new URL(`ws://127.0.0.1${requestUrl}`).searchParams.get('auto_mode')).toBe('true');
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
        if ('voice_settings' in message || !message.text) {
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
        if ('voice_settings' in message) {
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
        if (!('voice_settings' in message) && message.text) {
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
        if ('voice_settings' in message || !message.text) {
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

  it('replays the utterance on a fresh socket after a stall', async () => {
    let attempts = 0;
    const { initPackets, connections, events, errors } = await synthesizeWithConnOptions(
      { maxRetry: 1, retryIntervalMs: 0, timeoutMs: 150 },
      (ws, message) => {
        if ('voice_settings' in message || !message.text) {
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
        if (!answering || 'voice_settings' in message || !message.text) {
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
        if (!('voice_settings' in message) && message.text) {
          ws.send(JSON.stringify({ context_id: message.context_id, audio, isFinal: true }));
        }
      },
    );

    expect(errors).toHaveLength(0);
    expect(events.length).toBeGreaterThan(0);
  });
});
