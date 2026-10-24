import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createApp, DEFAULT_MODEL_ID, MODELS, getSpeechChunks } from '../server/index.js';
import { createMemoryDailyWordQuota } from '../server/quota.js';
import { MAX_AUDIO_BYTES, MAX_STREAM_WIRE_BYTES, decodeBase64PCM, pcmToFloat32, encodeWav, createNDJSONParser } from '../src/audio.js';

async function serve(t, synthesize, config = { apiKey: 'test-only', model: DEFAULT_MODEL_ID }, logger = console) {
  const quotaStore = createMemoryDailyWordQuota({ secret: 'test-quota-secret' });
  const server = createApp({ synthesize, config, logger, quotaStore }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return `http://127.0.0.1:${server.address().port}`;
}
const body = { text: 'Hello.', model: DEFAULT_MODEL_ID, voice: 'Kore' };
const post = (base, value = body) => fetch(`${base}/api/generate/stream`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value)
});

test('PCM little-endian conversion and complete WAV preserve samples', () => {
  assert.ok(MAX_STREAM_WIRE_BYTES > MAX_AUDIO_BYTES);
  const pcm = decodeBase64PCM(Buffer.from([0, 128, 0, 0, 255, 127]).toString('base64'));
  assert.deepEqual([...pcmToFloat32(pcm)], [-1, 0, 32767 / 32768]);
  const wav = encodeWav([pcm]);
  assert.equal(new DataView(wav.buffer).getUint32(24, true), 24000);
  assert.deepEqual(wav.slice(44), pcm);
  assert.throws(() => decodeBase64PCM('AA=='));
  assert.throws(() => decodeBase64PCM('AAB='));
  assert.throws(() => encodeWav([]));
});

test('NDJSON parser accepts split frames and rejects malformed or excessive data', () => {
  const events = [];
  const parser = createNDJSONParser(event => events.push(event));
  parser.push('{"type":"sta'); parser.push('rt"}\n{"type":"done"}'); parser.finish();
  assert.deepEqual(events.map(event => event.type), ['start', 'done']);
  assert.throws(() => createNDJSONParser(() => {}).push('invalid\n'));
  assert.throws(() => createNDJSONParser(() => {}, 3).push('1234'));
});

test('stream audio reaches consumer before synthesis completes', { timeout: 5000 }, async t => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  t.after(() => release());
  const base = await serve(t, async ({ onAudio, onProgress }) => {
    onAudio(Buffer.from([0, 0]));
    await gate;
    onProgress({ completedChunks: 1, totalChunks: 1 });
    return Buffer.alloc(0);
  });
  const response = await post(base);
  assert.equal(response.status, 200);
  const reader = response.body.getReader();
  let text = '';
  while (!text.includes('"audio"')) text += new TextDecoder().decode((await reader.read()).value);
  assert.ok(!text.includes('"done"'));
  release();
  while (true) { const { value, done } = await reader.read(); if (done) break; text += new TextDecoder().decode(value); }
  assert.deepEqual(text.trim().split('\n').map(line => JSON.parse(line).type), ['start', 'audio', 'progress', 'done']);
});

test('configuration excludes keys; validation and origin checks precede generation', async t => {
  let calls = 0;
  const base = await serve(t, async () => { calls++; });
  const config = await (await fetch(`${base}/api/config`)).json();
  assert.equal(config.configured, true);
  assert.deepEqual(config.auth, { enabled: false, signedIn: false, admin: false });
  assert.equal(config.guestWordLimit, 50);
  assert.equal(config.usage.wordsUsed, 0);
  assert.equal(Object.hasOwn(config, 'dailyWordQuota'), false);
  assert.equal(config.voices.length, 30);
  assert.equal((await fetch(`${base}/auth/google`, { redirect: 'manual' })).status, 503);
  assert.ok(!JSON.stringify(config).includes('test-only'));
  assert.equal((await post(base, { ...body, voice: 'unknown' })).status, 400);
  assert.equal((await post(base, { ...body, text: 'x'.repeat(1_000_001) })).status, 413);
  assert.equal((await fetch(`${base}/api/config`, { headers: { Origin: 'https://untrusted.example' } })).status, 403);
  assert.equal(calls, 0);
});

test('origin checks use a configured fixed origin, never the request Host', async t => {
  let calls = 0;
  const base = await serve(t, async () => { calls++; return Buffer.from([0, 0]); }, {
    apiKey: 'test-only',
    model: DEFAULT_MODEL_ID,
    publicOrigin: 'https://studio.example'
  });
  const allowed = await fetch(`${base}/api/config`, { headers: { Origin: 'https://studio.example' } });
  assert.equal(allowed.status, 200);
  const forged = await fetch(`${base}/api/generate`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Host: 'rebind.example',
      Origin: 'http://rebind.example'
    },
    body: JSON.stringify(body)
  });
  assert.equal(forged.status, 403);
  assert.equal(calls, 0);
});

test('server enforces the 50-word guest request cap without a daily block', async t => {
  let calls = 0;
  const base = await serve(t, async ({ onAudio, onProgress }) => {
    calls++;
    if (onAudio) {
      onAudio(Buffer.from([0, 0]));
      onProgress({ completedChunks: 1, totalChunks: 1 });
    }
    return Buffer.from([0, 0]);
  });
  const text = Array(50).fill('word').join(' ');
  const first = await fetch(`${base}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...body, text })
  });
  assert.equal(first.status, 200);
  const firstUsage = (await (await fetch(`${base}/api/config`)).json()).usage;
  assert.equal(firstUsage.wordsUsed, 50);
  assert.match(firstUsage.date, /^\d{4}-\d{2}-\d{2}$/);

  const repeated = await post(base, { ...body, text });
  assert.equal(repeated.status, 200);
  const events = (await repeated.text()).trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(events.map(event => event.type), ['start', 'audio', 'progress', 'done']);
  assert.deepEqual(events[0], { type: 'start', sampleRate: 24000, totalChunks: 1 });
  assert.deepEqual((await (await fetch(`${base}/api/config`)).json()).usage, {
    wordsUsed: 100, date: firstUsage.date
  });
  const overflow = await post(base, { ...body, text: Array(51).fill('word').join(' ') });
  assert.equal(overflow.status, 413);
  const rejection = await overflow.json();
  assert.match(rejection.error, /50-word per-request limit/);
  assert.equal(rejection.wordLimit, 50);
  assert.equal(calls, 2);
});

test('optional daily usage storage failures do not interrupt health, config, or generation', async t => {
  let calls = 0;
  const failedStorage = async () => { throw new Error('Usage storage unavailable.'); };
  const logger = { error() {} };
  const quotaStore = { getUsageFor: failedStorage, recordFor: failedStorage };
  const server = createApp({
    config: { apiKey: 'test-only', model: DEFAULT_MODEL_ID },
    quotaStore,
    logger,
    synthesize: async ({ onAudio, onProgress }) => {
      calls++;
      if (onAudio) {
        onAudio(Buffer.from([0, 0]));
        onProgress({ completedChunks: 1, totalChunks: 1 });
      }
      return Buffer.from([0, 0]);
    }
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(`${base}/api/health`)).status, 200);
  const config = await (await fetch(`${base}/api/config`)).json();
  assert.equal(config.usage, null);
  assert.equal(config.guestWordLimit, 50);
  assert.equal(Object.hasOwn(config, 'dailyWordQuota'), false);
  const response = await fetch(`${base}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  assert.equal(response.status, 200);
  assert.equal(calls, 1);
  const streamed = await post(base);
  assert.equal(streamed.status, 200);
  const events = (await streamed.text()).trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(events[0], { type: 'start', sampleRate: 24000, totalChunks: 1 });
  assert.equal(events.at(-1).type, 'done');
  assert.equal(calls, 2);
});

test('stalled informational usage storage cannot indefinitely delay generation', { timeout: 5000 }, async t => {
  const neverCompletes = () => new Promise(() => {});
  let calls = 0;
  const server = createApp({
    config: { apiKey: 'test-only', model: DEFAULT_MODEL_ID },
    quotaStore: { getUsageFor: neverCompletes, recordFor: neverCompletes },
    logger: { error() {} },
    synthesize: async () => { calls++; return Buffer.from([0, 0]); }
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const config = await (await fetch(`${base}/api/config`)).json();
  assert.equal(config.usage, null);
  const response = await fetch(`${base}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  assert.equal(response.status, 200);
  assert.equal(calls, 1);
});

test('stalled usage tracking still preserves the concurrent generation safety limit', { timeout: 5000 }, async t => {
  let usageCalls = 0;
  let notifyTwoStarted;
  const twoStarted = new Promise(resolve => { notifyTwoStarted = resolve; });
  const server = createApp({
    config: { apiKey: 'test-only', model: DEFAULT_MODEL_ID },
    quotaStore: {
      getUsageFor: async () => ({}),
      recordFor: () => {
        if (++usageCalls === 2) notifyTwoStarted();
        return new Promise(() => {});
      }
    },
    logger: { error() {} },
    synthesize: async () => Buffer.from([0, 0])
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = () => fetch(`${base}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const first = request();
  const second = request();
  await twoStarted;
  const third = await request();
  assert.equal(third.status, 429);
  assert.match((await third.json()).error, /Server is busy/);
  assert.deepEqual((await Promise.all([first, second])).map(response => response.status), [200, 200]);
});

test('Google sign-in validates OAuth state and unlocks all signed-in models', async t => {
  let authParameters;
  let authNonce;
  let invalidNonce = false;
  const oauthClient = {
    generateAuthUrl(parameters) {
      authParameters = parameters;
      const url = new URL('https://accounts.google.test/auth');
      url.searchParams.set('state', parameters.state);
      return url.toString();
    },
    async getToken(code) {
      assert.equal(code, 'authorization-code');
      return { tokens: { id_token: 'verified-id-token' } };
    },
    async verifyIdToken({ idToken, audience }) {
      assert.equal(idToken, 'verified-id-token');
      assert.equal(audience, 'test-client-id');
      return { getPayload: () => ({ sub: 'google-account-123', nonce: invalidNonce ? 'wrong-nonce' : authNonce }) };
    }
  };
  const base = await serve(t, async () => Buffer.from([0, 0]), {
    apiKey: 'test-only',
    model: DEFAULT_MODEL_ID,
    googleClientId: 'test-client-id',
    googleClientSecret: 'test-client-secret',
    googleRedirectUri: 'https://studio.example/auth/google/callback',
    sessionSecret: 'test-session-secret',
    oauthClient
  });
  const start = await fetch(`${base}/auth/google`, { redirect: 'manual' });
  assert.equal(start.status, 302);
  const initialCookie = start.headers.getSetCookie()[0].split(';')[0];
  assert.deepEqual(authParameters.scope, ['openid', 'email']);
  assert.ok(authParameters.state);
  const authorizationUrl = new URL(start.headers.get('location'));
  assert.equal(authorizationUrl.searchParams.get('state'), authParameters.state);
  authNonce = authorizationUrl.searchParams.get('nonce');
  assert.ok(authNonce);
  const rejected = await fetch(`${base}/auth/google/callback?code=authorization-code&state=wrong`, {
    headers: { Cookie: initialCookie },
    redirect: 'manual'
  });
  assert.equal(rejected.status, 400);
  const callback = await fetch(`${base}/auth/google/callback?code=authorization-code&state=${authParameters.state}`, {
    headers: { Cookie: initialCookie },
    redirect: 'manual'
  });
  assert.equal(callback.status, 302);
  const signedInCookie = callback.headers.getSetCookie()[0].split(';')[0];
  const signedInConfig = await (await fetch(`${base}/api/config`, { headers: { Cookie: signedInCookie } })).json();
  assert.deepEqual(signedInConfig.auth, { enabled: true, signedIn: true, admin: false });
  assert.equal(signedInConfig.usage.wordsUsed, 0);
  assert.equal(signedInConfig.guestWordLimit, 50);
  assert.equal(Object.hasOwn(signedInConfig, 'dailyWordQuota'), false);
  assert.equal(signedInConfig.user.plan, undefined);

  const accepted = await fetch(`${base}/api/generate`, {
    method: 'POST',
    headers: { Cookie: signedInCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...body, text: Array(1000).fill('word').join(' ') })
  });
  assert.equal(accepted.status, 200);
  const repeated = await fetch(`${base}/api/generate`, {
    method: 'POST',
    headers: { Cookie: signedInCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...body, text: 'one more word' })
  });
  assert.equal(repeated.status, 200);
  assert.equal((await (await fetch(`${base}/api/config`, { headers: { Cookie: signedInCookie } })).json()).usage.wordsUsed, 1003);
  for (const [model, limit] of [['gemini-3.8-live', 500], ['gemini-3.8-live-extended-thinking', 250]]) {
    const modelResponse = await fetch(`${base}/api/generate`, {
      method: 'POST',
      headers: { Cookie: signedInCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: Array(limit).fill('word').join(' '), model, voice: 'Kore' })
    });
    assert.equal(modelResponse.status, 200);
    const modelOverflow = await fetch(`${base}/api/generate`, {
      method: 'POST',
      headers: { Cookie: signedInCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: Array(limit + 1).fill('word').join(' '), model, voice: 'Kore' })
    });
    assert.equal(modelOverflow.status, 413);
  }
  const guestText = Array(51).fill('guest').join(' ');
  const guest = await fetch(`${base}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...body, text: guestText })
  });
  assert.equal(guest.status, 413);

  const signOut = await fetch(`${base}/api/auth/logout`, { method: 'POST', headers: { Cookie: signedInCookie } });
  assert.equal(signOut.status, 204);
  const signedOutConfig = await (await fetch(`${base}/api/config`, { headers: { Cookie: signedInCookie } })).json();
  assert.deepEqual(signedOutConfig.auth, { enabled: true, signedIn: false, admin: false });
  assert.equal(signedOutConfig.guestWordLimit, 50);
  assert.equal(signedOutConfig.usage.wordsUsed, 0);
  invalidNonce = true;
  const retry = await fetch(`${base}/auth/google`, { redirect: 'manual' });
  const retryCookie = retry.headers.getSetCookie()[0].split(';')[0];
  authNonce = new URL(retry.headers.get('location')).searchParams.get('nonce');
  const invalidIdentity = await fetch(`${base}/auth/google/callback?code=authorization-code&state=${authParameters.state}`, {
    headers: { Cookie: retryCookie },
    redirect: 'manual'
  });
  assert.equal(invalidIdentity.status, 400);
});

test('verified admin streams above every model cap but retains audio and rate safety guards', async t => {
  let state;
  let nonce;
  let synthesisCalls = 0;
  const oauthClient = {
    generateAuthUrl(parameters) {
      state = parameters.state;
      const url = new URL('https://accounts.google.test/auth');
      url.searchParams.set('state', state);
      return url.toString();
    },
    async getToken() { return { tokens: { id_token: 'verified-admin-token' } }; },
    async verifyIdToken() {
      return { getPayload: () => ({
        sub: 'google-admin-123',
        email: 'Admin@Example.com',
        email_verified: true,
        nonce
      }) };
    }
  };
  const base = await serve(t, async ({ text, onAudio, onProgress }) => {
    synthesisCalls++;
    if (text === 'oversized audio') return Buffer.alloc(MAX_AUDIO_BYTES + 2);
    if (onAudio) {
      const chunks = getSpeechChunks(text);
      for (let index = 0; index < chunks.length; index++) {
        onAudio(Buffer.from([0, 0]));
        onProgress({ completedChunks: index + 1, totalChunks: chunks.length });
      }
    }
    return Buffer.from([0, 0]);
  }, {
    apiKey: 'test-only',
    model: DEFAULT_MODEL_ID,
    googleClientId: 'test-client-id',
    googleClientSecret: 'test-client-secret',
    googleRedirectUri: 'https://studio.example/auth/google/callback',
    sessionSecret: 'test-session-secret',
    adminGoogleEmails: 'admin@example.com',
    generationRateLimit: 6,
    oauthClient
  }, { error() {} });
  const start = await fetch(`${base}/auth/google`, { redirect: 'manual' });
  const startCookie = start.headers.getSetCookie()[0].split(';')[0];
  nonce = new URL(start.headers.get('location')).searchParams.get('nonce');
  const callback = await fetch(`${base}/auth/google/callback?code=authorization-code&state=${state}`, {
    headers: { Cookie: startCookie },
    redirect: 'manual'
  });
  const adminCookie = callback.headers.getSetCookie()[0].split(';')[0];
  const config = await (await fetch(`${base}/api/config`, { headers: { Cookie: adminCookie } })).json();
  assert.deepEqual(config.auth, { enabled: true, signedIn: true, admin: true });
  assert.equal(config.usage.wordsUsed, 0);
  assert.equal(Object.hasOwn(config, 'dailyWordQuota'), false);

  const longText = Array(250).fill('word').join(' ');
  const accepted = await fetch(`${base}/api/generate`, {
    method: 'POST',
    headers: { Cookie: adminCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...body, text: longText, model: 'gemini-3.8-live-extended-thinking' })
  });
  assert.equal(accepted.status, 200);
  const repeated = await fetch(`${base}/api/generate`, {
    method: 'POST',
    headers: { Cookie: adminCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...body, text: longText, model: 'gemini-3.8-live-extended-thinking' })
  });
  assert.equal(repeated.status, 200);
  assert.equal(synthesisCalls, 2);
  const after = await (await fetch(`${base}/api/config`, { headers: { Cookie: adminCookie } })).json();
  assert.equal(after.usage.wordsUsed, 500);

  for (const model of MODELS) {
    const text = Array(model.wordLimit + 1).fill('word').join(' ');
    const streamed = await fetch(`${base}/api/generate/stream`, {
      method: 'POST', headers: { Cookie: adminCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...body, model: model.id, text })
    });
    assert.equal(streamed.status, 200, model.id);
    const events = (await streamed.text()).trim().split('\n').map(JSON.parse);
    const totalChunks = getSpeechChunks(text).length;
    assert.deepEqual(events[0], { type: 'start', sampleRate: 24000, totalChunks });
    assert.equal(events.filter(event => event.type === 'audio').length, totalChunks);
    assert.deepEqual(events.at(-2), { type: 'progress', completedChunks: totalChunks, totalChunks });
    assert.deepEqual(events.at(-1), { type: 'done' });
  }
  assert.equal(synthesisCalls, 5);
  const charOverflow = await fetch(`${base}/api/generate/stream`, {
    method: 'POST', headers: { Cookie: adminCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...body, model: MODELS[2].id, text: 'x'.repeat(MODELS[2].characterLimit + 1) })
  });
  assert.equal(charOverflow.status, 413);

  const audioOverflow = await fetch(`${base}/api/generate`, {
    method: 'POST', headers: { Cookie: adminCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...body, text: 'oversized audio' })
  });
  assert.equal(audioOverflow.status, 502);
  assert.match((await audioOverflow.json()).error, /no completed WAV/);
  const busy = await fetch(`${base}/api/generate`, {
    method: 'POST', headers: { Cookie: adminCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  assert.equal(busy.status, 429);
  assert.match((await busy.json()).error, /Too many generation requests/);
  assert.equal(synthesisCalls, 6);
});

test('failed or incomplete synthesis never emits done or leaks errors', async t => {
  const logged = [];
  const base = await serve(t, async ({ text, onAudio }) => {
    onAudio(Buffer.from([0, 0]));
    throw new Error(`provider refused ${text} with key test-only`);
  }, undefined, { error: (...args) => logged.push(args) });
  const response = await post(base);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') || '', /application\/x-ndjson/);
  const text = await response.text();
  const events = text.trim().split('\n').map(JSON.parse);
  assert.deepEqual(events.map(event => event.type), ['start', 'audio', 'error']);
  assert.ok(!text.includes('provider refused'));
  assert.equal(logged.length, 1);
  assert.equal((await (await fetch(`${base}/api/config`)).json()).usage.wordsUsed, 1);
  assert.deepEqual(logged[0][1], {
    name: 'Error',
    message: 'provider refused [script redacted] with key [redacted]',
    code: undefined,
    status: undefined,
    closeReason: undefined,
    completedChunks: 0,
    totalChunks: 1,
    audioBytes: 2
  });
});

test('stream logs turn-level timeout diagnostics without exposing the script', async t => {
  const logged = [];
  const base = await serve(t, async ({ onAudio }) => {
    onAudio(Buffer.from([0, 0]));
    const error = new Error('Live turn stopped producing audio before completion.');
    error.code = 'LIVE_TURN_INACTIVITY_TIMEOUT';
    error.turnNumber = 1;
    error.turnAudioBytes = 2;
    throw error;
  }, undefined, { error: (...args) => logged.push(args) });

  const response = await post(base, { ...body, text: 'private script text' });
  assert.equal(response.status, 200);
  await response.text();
  assert.deepEqual(logged[0][1], {
    name: 'Error',
    message: 'Live turn stopped producing audio before completion.',
    code: 'LIVE_TURN_INACTIVITY_TIMEOUT',
    status: undefined,
    closeReason: undefined,
    completedChunks: 0,
    totalChunks: 1,
    audioBytes: 2,
    turnNumber: 1,
    turnAudioBytes: 2
  });
});

test('stream logs client disconnect diagnostics separately from provider failures', async t => {
  const logged = [];
  const base = await serve(t, async ({ signal, onAudio }) => {
    onAudio(Buffer.from([0, 0]));
    await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
    const error = new Error('Client disconnected.');
    error.code = 'CLIENT_DISCONNECTED';
    error.turnNumber = 1;
    error.turnAudioBytes = 2;
    throw error;
  }, undefined, { error: (...args) => logged.push(args) });

  const controller = new AbortController();
  const responsePromise = fetch(`${base}/api/generate/stream`, {
    method: 'POST',
    signal: controller.signal,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const response = await responsePromise;
  assert.equal(response.status, 200);
  controller.abort();
  try { await response.text(); } catch {}
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(logged.length, 1);
  assert.equal(logged[0][1].code, 'CLIENT_DISCONNECTED');
  assert.equal(logged[0][1].turnNumber, 1);
  assert.equal(logged[0][1].turnAudioBytes, 2);
});

test('missing configuration blocks requests without contacting provider', async t => {
  const base = await serve(t, () => { throw new Error('must not run'); }, { apiKey: '', model: DEFAULT_MODEL_ID });
  assert.equal((await post(base)).status, 503);
  assert.equal((await (await fetch(`${base}/api/config`)).json()).configured, false);
});

test('signed-in stream requests enforce model caps but remain repeatable after daily usage fills', async t => {
  let authParameters;
  let authNonce;
  const oauthClient = {
    generateAuthUrl(parameters) {
      authParameters = parameters;
      const url = new URL('https://accounts.google.test/auth');
      url.searchParams.set('state', parameters.state);
      return url.toString();
    },
    async getToken() { return { tokens: { id_token: 'verified-user-token' } }; },
    async verifyIdToken() { return { getPayload: () => ({ sub: 'google-user', nonce: authNonce }) }; }
  };

  let synthesisCalls = 0;
  const synthesize = async ({ text, onAudio, onProgress }) => {
    synthesisCalls++;
    const chunks = getSpeechChunks(text);
    for (let index = 0; index < chunks.length; index++) {
      onAudio(Buffer.from([0, 0]));
      onProgress({ completedChunks: index + 1, totalChunks: chunks.length });
    }
    return Buffer.alloc(0);
  };

  const base = await serve(t, synthesize, {
    apiKey: 'test-only',
    model: DEFAULT_MODEL_ID,
    googleClientId: 'test-client-id',
    googleClientSecret: 'test-client-secret',
    googleRedirectUri: 'https://studio.example/auth/google/callback',
    sessionSecret: 'test-session-secret',
    oauthClient
  });

  const start = await fetch(`${base}/auth/google`, { redirect: 'manual' });
  const initialCookie = start.headers.getSetCookie()[0].split(';')[0];
  authNonce = new URL(start.headers.get('location')).searchParams.get('nonce');
  const callback = await fetch(`${base}/auth/google/callback?code=authorization-code&state=${authParameters.state}`, {
    headers: { Cookie: initialCookie },
    redirect: 'manual'
  });
  const signedInCookie = callback.headers.getSetCookie()[0].split(';')[0];

  const config = await (await fetch(`${base}/api/config`, { headers: { Cookie: signedInCookie } })).json();
  assert.equal(config.user.plan, undefined);
  assert.equal(config.usage.wordsUsed, 0);
  assert.equal(Object.hasOwn(config, 'dailyWordQuota'), false);

  const text1000 = Array(1000).fill('word').join(' ');
  const res = await fetch(`${base}/api/generate/stream`, {
    method: 'POST',
    headers: { Cookie: signedInCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: text1000, model: DEFAULT_MODEL_ID, voice: 'Kore' })
  });
  assert.equal(res.status, 200);

  const rawStream = await res.text();
  const events = rawStream.trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(events[0], { type: 'start', sampleRate: 24000, totalChunks: 10 });

  const doneEvent = events[events.length - 1];
  assert.equal(doneEvent.type, 'done');
  assert.ok(!events.some(e => e.type === 'error'));

  const audioEvents = events.filter(e => e.type === 'audio');
  assert.equal(audioEvents.length, 10);
  assert.ok(audioEvents.every(e => typeof e.data === 'string' && e.data.length > 0));
  const decodedAudioBytes = audioEvents.reduce((acc, ev) => acc + decodeBase64PCM(ev.data).byteLength, 0);
  assert.equal(decodedAudioBytes, 20);

  assert.equal(synthesisCalls, 1);

  const nextRes = await fetch(`${base}/api/generate/stream`, {
    method: 'POST',
    headers: { Cookie: signedInCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: 'one more word', model: DEFAULT_MODEL_ID, voice: 'Kore' })
  });
  assert.equal(nextRes.status, 200);
  await nextRes.text();
  assert.equal(synthesisCalls, 2);
  assert.equal((await (await fetch(`${base}/api/config`, { headers: { Cookie: signedInCookie } })).json()).usage.wordsUsed, 1003);

  const overflow = await fetch(`${base}/api/generate/stream`, {
    method: 'POST',
    headers: { Cookie: signedInCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: Array(1001).fill('word').join(' '), model: DEFAULT_MODEL_ID, voice: 'Kore' })
  });
  assert.equal(overflow.status, 413);
  assert.equal((await overflow.json()).wordLimit, 1000);
  assert.equal(synthesisCalls, 2);
});
