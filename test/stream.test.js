import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createApp, DEFAULT_MODEL_ID, getSpeechChunks } from '../server/index.js';
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

test('server enforces a shared 50-word guest quota per IP', async t => {
  let calls = 0;
  const base = await serve(t, async () => { calls++; return Buffer.from([0, 0]); });
  const text = Array(50).fill('word').join(' ');
  const first = await fetch(`${base}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...body, text })
  });
  assert.equal(first.status, 200);
  const firstUsage = (await (await fetch(`${base}/api/config`)).json()).dailyWordQuota;
  assert.equal(firstUsage.limit, 50);
  assert.equal(firstUsage.used, 50);
  assert.equal(firstUsage.remaining, 0);

  const next = await post(base, { ...body, text: 'one more word' });
  assert.equal(next.status, 429);
  const rejection = await next.json();
  assert.match(rejection.error, /Daily limit reached/);
  assert.equal(rejection.dailyWordQuota.remaining, 0);
  assert.equal(calls, 1);
});

test('Google sign-in validates OAuth state and grants a separate 1000-word account quota', async t => {
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
  assert.equal(signedInConfig.dailyWordQuota.limit, 1000);

  const userText = Array(51).fill('word').join(' ');
  const accepted = await fetch(`${base}/api/generate`, {
    method: 'POST',
    headers: { Cookie: signedInCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...body, text: userText })
  });
  assert.equal(accepted.status, 200);
  assert.equal((await (await fetch(`${base}/api/config`, { headers: { Cookie: signedInCookie } })).json()).dailyWordQuota.used, 51);
  const overAccountLimit = await fetch(`${base}/api/generate`, {
    method: 'POST',
    headers: { Cookie: signedInCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...body, text: Array(950).fill('word').join(' ') })
  });
  assert.equal(overAccountLimit.status, 429);
  const finalAccountWords = await fetch(`${base}/api/generate`, {
    method: 'POST',
    headers: { Cookie: signedInCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...body, text: Array(949).fill('word').join(' ') })
  });
  assert.equal(finalAccountWords.status, 200);
  const accountLimit = await fetch(`${base}/api/generate`, {
    method: 'POST',
    headers: { Cookie: signedInCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...body, text: 'one' })
  });
  assert.equal(accountLimit.status, 429);
  assert.equal((await accountLimit.json()).dailyWordQuota.remaining, 0);

  const guestText = Array(51).fill('guest').join(' ');
  const guest = await fetch(`${base}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...body, text: guestText })
  });
  assert.equal(guest.status, 429);
  assert.equal((await guest.json()).dailyWordQuota.limit, 50);

  const signOut = await fetch(`${base}/api/auth/logout`, { method: 'POST', headers: { Cookie: signedInCookie } });
  assert.equal(signOut.status, 204);
  const signedOutConfig = await (await fetch(`${base}/api/config`, { headers: { Cookie: signedInCookie } })).json();
  assert.deepEqual(signedOutConfig.auth, { enabled: true, signedIn: false, admin: false });
  assert.equal(signedOutConfig.dailyWordQuota.limit, 50);
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

test('allowlisted verified Google account bypasses only the daily word quota', async t => {
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
  const base = await serve(t, async () => {
    synthesisCalls++;
    return Buffer.from([0, 0]);
  }, {
    apiKey: 'test-only',
    model: DEFAULT_MODEL_ID,
    googleClientId: 'test-client-id',
    googleClientSecret: 'test-client-secret',
    googleRedirectUri: 'https://studio.example/auth/google/callback',
    sessionSecret: 'test-session-secret',
    adminGoogleEmails: 'admin@example.com',
    oauthClient
  });
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
  assert.equal(config.dailyWordQuota.unlimited, true);

  const longText = Array(1001).fill('word').join(' ');
  const accepted = await fetch(`${base}/api/generate`, {
    method: 'POST',
    headers: { Cookie: adminCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...body, text: longText })
  });
  assert.equal(accepted.status, 200);
  assert.equal(synthesisCalls, 1);
  const after = await (await fetch(`${base}/api/config`, { headers: { Cookie: adminCookie } })).json();
  assert.equal(after.dailyWordQuota.unlimited, true);
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
  assert.equal((await (await fetch(`${base}/api/config`)).json()).dailyWordQuota.used, 1);
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

test('Pro plan accepts full 3000-word payload in a single request and enforces limit', async t => {
  let authParameters;
  let authNonce;
  const oauthClient = {
    generateAuthUrl(parameters) {
      authParameters = parameters;
      const url = new URL('https://accounts.google.test/auth');
      url.searchParams.set('state', parameters.state);
      return url.toString();
    },
    async getToken() { return { tokens: { id_token: 'verified-pro-token' } }; },
    async verifyIdToken() { return { getPayload: () => ({ sub: 'google-pro-user', nonce: authNonce }) }; }
  };

  let synthesisCalls = 0;
  let totalChunksProcessed = 0;
  const synthesize = async ({ text, onAudio, onProgress }) => {
    synthesisCalls++;
    const chunks = getSpeechChunks(text);
    totalChunksProcessed = chunks.length;
    for (let i = 0; i < chunks.length; i++) {
      onAudio(Buffer.from([0, 0]));
      onProgress({ completedChunks: i + 1, totalChunks: chunks.length });
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

  const subRes = await fetch(`${base}/api/plans/subscribe-test`, {
    method: 'POST',
    headers: { Cookie: signedInCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ plan: 'pro', confirm: true })
  });
  assert.equal(subRes.status, 200);
  const subData = await subRes.json();
  assert.equal(subData.ok, true);
  assert.equal(subData.plan, 'pro');

  const config = await (await fetch(`${base}/api/config`, { headers: { Cookie: signedInCookie } })).json();
  assert.equal(config.user.plan, 'pro');
  assert.equal(config.dailyWordQuota.limit, 3000);
  assert.equal(config.dailyWordQuota.used, 0);
  assert.equal(config.dailyWordQuota.remaining, 3000);

  const text3000 = Array(3000).fill('word').join(' ');
  const res = await fetch(`${base}/api/generate/stream`, {
    method: 'POST',
    headers: { Cookie: signedInCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: text3000, model: DEFAULT_MODEL_ID, voice: 'Kore' })
  });
  assert.equal(res.status, 200);

  const rawStream = await res.text();
  const events = rawStream.trim().split('\n').map(line => JSON.parse(line));
  assert.equal(events[0].type, 'start');
  assert.equal(events[0].sampleRate, 24000);
  assert.equal(events[0].totalChunks, 30);
  assert.equal(events[0].dailyWordQuota.limit, 3000);
  assert.equal(events[0].dailyWordQuota.used, 3000);
  assert.equal(events[0].dailyWordQuota.remaining, 0);

  const doneEvent = events[events.length - 1];
  assert.equal(doneEvent.type, 'done');
  assert.ok(!events.some(e => e.type === 'error'));

  const audioEvents = events.filter(e => e.type === 'audio');
  assert.equal(audioEvents.length, 30);
  assert.ok(audioEvents.every(e => typeof e.data === 'string' && e.data.length > 0));
  const decodedAudioBytes = audioEvents.reduce((acc, ev) => acc + decodeBase64PCM(ev.data).byteLength, 0);
  assert.equal(decodedAudioBytes, 30 * 2);

  assert.equal(synthesisCalls, 1);
  assert.equal(totalChunksProcessed, 30);

  const quotaAfter = (await (await fetch(`${base}/api/config`, { headers: { Cookie: signedInCookie } })).json()).dailyWordQuota;
  assert.equal(quotaAfter.used, 3000);
  assert.equal(quotaAfter.remaining, 0);

  const nextRes = await fetch(`${base}/api/generate/stream`, {
    method: 'POST',
    headers: { Cookie: signedInCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: 'one more word', model: DEFAULT_MODEL_ID, voice: 'Kore' })
  });
  assert.equal(nextRes.status, 429);
  const rejection = await nextRes.json();
  assert.match(rejection.error, /Daily limit reached/);
  assert.equal(rejection.dailyWordQuota.remaining, 0);
});

test('Studio plan accepts full 5000-word peak capacity payload in a single request and enforces limit', async t => {
  let authParameters;
  let authNonce;
  const oauthClient = {
    generateAuthUrl(parameters) {
      authParameters = parameters;
      const url = new URL('https://accounts.google.test/auth');
      url.searchParams.set('state', parameters.state);
      return url.toString();
    },
    async getToken() { return { tokens: { id_token: 'verified-studio-token' } }; },
    async verifyIdToken() { return { getPayload: () => ({ sub: 'google-studio-user', nonce: authNonce }) }; }
  };

  let synthesisCalls = 0;
  let totalChunksProcessed = 0;
  const synthesize = async ({ text, onAudio, onProgress }) => {
    synthesisCalls++;
    const chunks = getSpeechChunks(text);
    totalChunksProcessed = chunks.length;
    for (let i = 0; i < chunks.length; i++) {
      onAudio(Buffer.from([0, 0]));
      onProgress({ completedChunks: i + 1, totalChunks: chunks.length });
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

  const subRes = await fetch(`${base}/api/plans/subscribe-test`, {
    method: 'POST',
    headers: { Cookie: signedInCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ plan: 'studio', confirm: true })
  });
  assert.equal(subRes.status, 200);
  const subData = await subRes.json();
  assert.equal(subData.ok, true);
  assert.equal(subData.plan, 'studio');

  const config = await (await fetch(`${base}/api/config`, { headers: { Cookie: signedInCookie } })).json();
  assert.equal(config.user.plan, 'studio');
  assert.equal(config.dailyWordQuota.limit, 5000);
  assert.equal(config.dailyWordQuota.unlimited, undefined);
  assert.equal(config.dailyWordQuota.used, 0);
  assert.equal(config.dailyWordQuota.remaining, 5000);

  const text5000 = Array(5000).fill('word').join(' ');
  const res = await fetch(`${base}/api/generate/stream`, {
    method: 'POST',
    headers: { Cookie: signedInCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: text5000, model: DEFAULT_MODEL_ID, voice: 'Kore' })
  });
  assert.equal(res.status, 200);

  const rawStream = await res.text();
  const events = rawStream.trim().split('\n').map(line => JSON.parse(line));
  assert.equal(events[0].type, 'start');
  assert.equal(events[0].sampleRate, 24000);
  assert.equal(events[0].totalChunks, 50);
  assert.equal(events[0].dailyWordQuota.limit, 5000);
  assert.equal(events[0].dailyWordQuota.used, 5000);
  assert.equal(events[0].dailyWordQuota.remaining, 0);

  const doneEvent = events[events.length - 1];
  assert.equal(doneEvent.type, 'done');
  assert.ok(!events.some(e => e.type === 'error'));

  const audioEvents = events.filter(e => e.type === 'audio');
  assert.equal(audioEvents.length, 50);
  assert.ok(audioEvents.every(e => typeof e.data === 'string' && e.data.length > 0));
  const decodedAudioBytes = audioEvents.reduce((acc, ev) => acc + decodeBase64PCM(ev.data).byteLength, 0);
  assert.equal(decodedAudioBytes, 50 * 2);

  assert.equal(synthesisCalls, 1);
  assert.equal(totalChunksProcessed, 50);

  const quotaAfter = (await (await fetch(`${base}/api/config`, { headers: { Cookie: signedInCookie } })).json()).dailyWordQuota;
  assert.equal(quotaAfter.used, 5000);
  assert.equal(quotaAfter.remaining, 0);

  const nextRes = await fetch(`${base}/api/generate/stream`, {
    method: 'POST',
    headers: { Cookie: signedInCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: 'one more word', model: DEFAULT_MODEL_ID, voice: 'Kore' })
  });
  assert.equal(nextRes.status, 429);
  const rejection = await nextRes.json();
  assert.match(rejection.error, /Daily limit reached/);
  assert.equal(rejection.dailyWordQuota.remaining, 0);
});
