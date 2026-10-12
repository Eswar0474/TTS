import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createApp, DEFAULT_MODEL_ID } from '../server/index.js';
import { createMemoryDailyWordQuota } from '../server/quota.js';
import { decodeBase64PCM, pcmToFloat32, encodeWav, createNDJSONParser } from '../src/audio.js';

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
  const pcm = decodeBase64PCM(Buffer.from([0, 128, 0, 0, 255, 127]).toString('base64'));
  assert.deepEqual([...pcmToFloat32(pcm)], [-1, 0, 32767 / 32768]);
  const wav = encodeWav([pcm]);
  assert.equal(new DataView(wav.buffer).getUint32(24, true), 24000);
  assert.deepEqual(wav.slice(44), pcm);
  assert.throws(() => decodeBase64PCM('AA=='));
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
  assert.equal(config.voices.length, 30);
  assert.ok(!JSON.stringify(config).includes('test-only'));
  assert.equal((await post(base, { ...body, voice: 'unknown' })).status, 400);
  assert.equal((await post(base, { ...body, text: 'x'.repeat(1_000_001) })).status, 413);
  assert.equal((await fetch(`${base}/api/config`, { headers: { Origin: 'https://untrusted.example' } })).status, 403);
  assert.equal(calls, 0);
});

test('server enforces one shared 1000-word daily quota across requests', async t => {
  let calls = 0;
  const base = await serve(t, async () => { calls++; return Buffer.from([0, 0]); });
  const text = Array(1000).fill('word').join(' ');
  const first = await fetch(`${base}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...body, text })
  });
  assert.equal(first.status, 200);
  const firstUsage = (await (await fetch(`${base}/api/config`)).json()).dailyWordQuota;
  assert.equal(firstUsage.limit, 1000);
  assert.equal(firstUsage.used, 1000);
  assert.equal(firstUsage.remaining, 0);

  const next = await post(base, { ...body, text: 'one more word' });
  assert.equal(next.status, 429);
  const rejection = await next.json();
  assert.match(rejection.error, /Daily limit reached/);
  assert.equal(rejection.dailyWordQuota.remaining, 0);
  assert.equal(calls, 1);
});

test('failed or incomplete synthesis never emits done or leaks errors', async t => {
  const logged = [];
  const base = await serve(t, async ({ text, onAudio }) => {
    onAudio(Buffer.from([0, 0]));
    throw new Error(`provider refused ${text} with key test-only`);
  }, undefined, { error: (...args) => logged.push(args) });
  const response = await post(base);
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

test('missing configuration blocks requests without contacting provider', async t => {
  const base = await serve(t, () => { throw new Error('must not run'); }, { apiKey: '', model: DEFAULT_MODEL_ID });
  assert.equal((await post(base)).status, 503);
  assert.equal((await (await fetch(`${base}/api/config`)).json()).configured, false);
});
