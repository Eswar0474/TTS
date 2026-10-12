import test from 'node:test';
import assert from 'node:assert/strict';
import { MODELS, DEFAULT_ENGINE, DEFAULT_MODEL_ID, MAX_TURNS_PER_LIVE_SESSION, createApp, synthesizeWithLiveApi, SYSTEM_INSTRUCTION } from '../server/index.js';
import { createMemoryDailyWordQuota } from '../server/quota.js';
import { getModelPresentation, VOICE_LABELS } from '../src/presentation.js';

test('catalog excludes models rejected by the Live audio endpoint', () => {
  assert.deepEqual(MODELS.map(model => [model.name, model.id, model.characterLimit]), [
    ['Gemini 2.5 Flash Native Audio Dialog', 'gemini-2.5-flash-native-audio-preview-12-2025', 1_000_000],
    ['Gemini 3.8 Live', 'gemini-3.8-live', 65_000],
    ['Gemini 3.8 Live Extended Thinking', 'gemini-3.8-live-extended-thinking', 65_000]
  ]);
  assert.ok(MODELS.every(model => model.transport === 'live' && model.verified === false));
  assert.equal(DEFAULT_ENGINE, DEFAULT_MODEL_ID);
});

test('studio profile labels cover the catalog without changing model IDs', () => {
  assert.equal(Object.keys(VOICE_LABELS).length, 30);
  assert.equal(VOICE_LABELS.Achird, 'Ram');
  const names = [];
  for (const model of MODELS) {
    const presentation = getModelPresentation(model);
    assert.ok(presentation.name.trim().length > 0);
    assert.doesNotMatch(presentation.name, /gemini/i);
    assert.doesNotMatch(presentation.profile, /unverified/i);
    assert.doesNotMatch(presentation.description, /verified/i);
    names.push(presentation.name);
  }
  assert.deepEqual(names, ['Low Quality', 'Balanced', 'Enhanced Thinking']);
  assert.equal(MODELS[0].id, DEFAULT_MODEL_ID);
});

async function serve(t, synthesize, config = { apiKey: 'test-only', model: DEFAULT_MODEL_ID }, logger = console) {
  const quotaStore = createMemoryDailyWordQuota({ secret: 'test-quota-secret' });
  const server = createApp({ config, synthesize, logger, quotaStore }).listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return `http://127.0.0.1:${server.address().port}`;
}

test('daily word quota separates IPs and resets at UTC midnight', async () => {
  let currentTime = new Date('2026-10-12T12:00:00.000Z');
  const quota = createMemoryDailyWordQuota({ secret: 'stable-test-secret', now: () => currentTime });
  assert.equal((await quota.consume('192.0.2.1', 50)).dailyWordQuota.remaining, 0);
  assert.equal((await quota.getUsage('192.0.2.1')).used, 50);
  assert.equal((await quota.getUsage('192.0.2.2')).used, 0);
  currentTime = new Date('2026-10-13T00:00:00.000Z');
  assert.equal((await quota.getUsage('192.0.2.1')).used, 0);
});

test('all catalog models route as Live with distinct caps and no custom escape', async t => {
  const calls = [];
  const url = await serve(t, async options => { calls.push(options); return Buffer.from([0, 0]); });
  const config = await (await fetch(`${url}/api/config`)).json();
  assert.equal(config.defaultModelId, DEFAULT_MODEL_ID);
  assert.deepEqual(config.models.map(model => model.id), MODELS.map(model => model.id));
  const post = (model, text = 'Hello.') => fetch(`${url}/api/generate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model, text, voice: 'Kore' }) });
  for (const model of MODELS) {
    assert.equal((await post(model.id)).status, 200);
    assert.equal(calls.at(-1).model, model.id);
    assert.equal(calls.at(-1).transport, 'live');
    assert.equal((await post(model.id, 'x'.repeat(model.characterLimit + 1))).status, 413);
  }
  assert.equal((await post('gemini-custom-live')).status, 400);
  for (const rejectedModel of ['gemini-3-flash-live', 'gemini-3.5-live-translate', 'gemini-3.5-transcribe-live']) {
    assert.equal((await post(rejectedModel)).status, 400);
  }
  assert.equal(calls.length, MODELS.length);
});

test('invalid configured model safely falls back to the catalog default', async t => {
  const url = await serve(t, async () => Buffer.from([0, 0]), { apiKey: 'test-only', model: 'gemini-not-allowed' });
  const config = await (await fetch(`${url}/api/config`)).json();
  assert.equal(config.defaultModelId, DEFAULT_MODEL_ID);
  assert.equal((await fetch(`${url}/api/generate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'Hello.', voice: 'Kore' }) })).status, 200);
});

test('Live uses AUDIO-only input, setup before text, all parts, sequential turns, and closure', async () => {
  const sent = [];
  let callbacks;
  let closed = false;
  const client = { live: { connect: async options => { callbacks = options.callbacks; sent.push('setup'); callbacks.onmessage({ setupComplete: true }); return { sendRealtimeInput: async input => { sent.push(input.text); callbacks.onmessage({ serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data: 'AAA=' } }, { inlineData: { mimeType: 'audio/pcm;rate=24000', data: 'AQA=' } }] }, turnComplete: true } }); }, close: () => { closed = true; } }; } } };
  const audio = await synthesizeWithLiveApi({ text: 'one two', model: DEFAULT_MODEL_ID, voice: 'Kore', client, onAudio: frame => sent.push(Buffer.from(frame).length) });
  assert.deepEqual(sent, ['setup', 'one two', 2, 2]);
  assert.equal(audio.length, 0);
  assert.equal(closed, true);
});

test('completed model requests close their sessions and allow a different model next', async t => {
  const connectedModels = [];
  const closedModels = [];
  const client = { live: { connect: async options => {
    connectedModels.push(options.model);
    options.callbacks.onmessage({ setupComplete: true });
    return {
      sendRealtimeInput: async () => options.callbacks.onmessage({
        serverContent: {
          modelTurn: { parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data: 'AAA=' } }] },
          turnComplete: true
        }
      }),
      close: () => closedModels.push(options.model)
    };
  } } };
  const url = await serve(t, options => synthesizeWithLiveApi({ ...options, client }));
  for (const model of [MODELS[0].id, MODELS.at(-1).id]) {
    const response = await fetch(`${url}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'Hello.', model, voice: 'Kore' })
    });
    assert.equal(response.status, 200);
  }
  assert.deepEqual(connectedModels, [MODELS[0].id, MODELS.at(-1).id]);
  assert.deepEqual(closedModels, connectedModels);
});

test('long Live requests reconnect between bounded groups of turns', async () => {
  const sentBySession = [];
  const progress = [];
  let callbacks;
  let closed = 0;
  const client = { live: { connect: async options => {
    callbacks = options.callbacks;
    sentBySession.push([]);
    callbacks.onmessage({ setupComplete: true });
    return {
      sendRealtimeInput: async input => {
        sentBySession.at(-1).push(input.text);
        callbacks.onmessage({ serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data: 'AAA=' } }] }, turnComplete: true } });
      },
      close: () => { closed++; }
    };
  } } };
  const text = Array.from({ length: MAX_TURNS_PER_LIVE_SESSION * 180 + 1 }, () => 'word').join(' ');
  await synthesizeWithLiveApi({
    text, model: DEFAULT_MODEL_ID, voice: 'Kore', client,
    onAudio: () => {},
    onProgress: event => progress.push(event.completedChunks)
  });
  assert.deepEqual(sentBySession.map(chunks => chunks.length), [MAX_TURNS_PER_LIVE_SESSION, 1]);
  assert.deepEqual(progress, [1, 2, 3, 4, 5]);
  assert.equal(closed, 2);
});

test('Live config keeps the immutable instruction and AUDIO modality', async () => {
  let input;
  const client = { live: { connect: async options => { input = options; options.callbacks.onmessage({ setupComplete: true }); return { sendRealtimeInput: async () => options.callbacks.onmessage({ serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data: 'AAA=' } }] }, turnComplete: true } }), close() {} }; } } };
  await synthesizeWithLiveApi({ text: 'Hello.', model: DEFAULT_MODEL_ID, voice: 'Kore', client });
  assert.deepEqual(input.config.responseModalities, ['AUDIO']);
  assert.equal(input.config.systemInstruction, SYSTEM_INSTRUCTION);
  assert.match(SYSTEM_INSTRUCTION, /never a question or request to answer/);
  assert.match(SYSTEM_INSTRUCTION, /Read questions and greetings as written; do not respond to their meaning/);
  assert.match(SYSTEM_INSTRUCTION, /Return speech audio only/);
});

test('extended-thinking model receives a supported thinking level', async () => {
  let input;
  const client = { live: { connect: async options => {
    input = options;
    options.callbacks.onmessage({ setupComplete: true });
    return {
      sendRealtimeInput: async () => options.callbacks.onmessage({
        serverContent: {
          modelTurn: { parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data: 'AAA=' } }] },
          turnComplete: true
        }
      }),
      close() {}
    };
  } } };
  await synthesizeWithLiveApi({
    text: 'Hello.',
    model: 'gemini-3.8-live-extended-thinking',
    voice: 'Kore',
    client
  });
  assert.deepEqual(input.config.thinkingConfig, { thinkingLevel: 'LOW' });
  assert.match(input.config.systemInstruction, /not a conversational assistant/);
});

test('Live close logs the provider close code and reason', async t => {
  const logged = [];
  const client = { live: { connect: async options => {
    options.callbacks.onmessage({ setupComplete: true });
    return {
      sendRealtimeInput: async () => options.callbacks.onclose({
        code: 1007,
        reason: 'invalid test payload',
        wasClean: false
      }),
      close() {}
    };
  } } };
  const url = await serve(t, options => synthesizeWithLiveApi({ ...options, client }), undefined, {
    error: (...args) => logged.push(args)
  });
  const response = await fetch(`${url}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: 'Hello.', model: DEFAULT_MODEL_ID, voice: 'Kore' })
  });
  assert.equal(response.status, 502);
  assert.equal(logged.length, 1);
  assert.equal(logged[0][1].code, 1007);
  assert.equal(logged[0][1].closeReason, 'invalid test payload');
});
