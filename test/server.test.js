import test from 'node:test';
import assert from 'node:assert/strict';
import { MODEL_LIMITS, SYSTEM_INSTRUCTION, splitIntoChunks, getSpeechChunks, decodeBase64PCM, wavHeader, VOICES } from '../server/index.js';

test('default and remaining model application caps are retained', () => {
  assert.equal(MODEL_LIMITS['gemini-2.5-flash-native-audio-dialog'], 1_000_000);
  assert.equal(MODEL_LIMITS['gemini-3.8-live'], 65_000);
  assert.equal(MODEL_LIMITS['gemini-3.8-live-extended-thinking'], 65_000);
  for (const rejected of ['gemini-3-flash-live', 'gemini-3.5-live-translate', 'gemini-3.5-transcribe-live']) {
    assert.equal(MODEL_LIMITS[rejected], undefined);
  }
});
test('chunking keeps punctuation boundaries and word limits', () => {
  const chunks = splitIntoChunks('First sentence. Second sentence! Third sentence?', 2);
  assert.deepEqual(chunks, ['First sentence. ', 'Second sentence! ', 'Third sentence?']);
});
test('chunking preserves exact input and enforces unpunctuated word bounds', () => {
  for (const input of ['  One\n two three four five  ', '<Wait... did hear that? you>\nNext.', '!!!', '   ', '']) {
    const chunks = splitIntoChunks(input, 2);
    assert.equal(chunks.join(''), input);
    assert.ok(chunks.every(chunk => (chunk.match(/\S+/g) || []).length <= 2));
  }
  assert.throws(() => splitIntoChunks('test', 0), RangeError);
});
test('provider speech chunks never contain whitespace-only turns', () => {
  const input = `${' '.repeat(4_000)}Hello.\n${'\t'.repeat(4_000)}World.`;
  const chunks = getSpeechChunks(input);
  assert.equal(chunks.join(''), input);
  assert.ok(chunks.length > 0);
  assert.ok(chunks.every(chunk => chunk.trim().length > 0));
});
test('large valid base64 PCM is decoded without regex stack overflow', () => {
  const source = Buffer.alloc(8_000_000).toString('base64');
  assert.equal(decodeBase64PCM(source).length, 8_000_000);
  assert.throws(() => decodeBase64PCM(`${source.slice(0, -4)}A===`), /base64|PCM/);
});
test('WAV describes mono 24kHz 16-bit PCM with exact byte sizes', () => {
  const header = wavHeader(48000);
  assert.equal(header.length, 44);
  assert.equal(header.readUInt32LE(4), 48036);
  assert.equal(header.readUInt16LE(22), 1);
  assert.equal(header.readUInt32LE(24), 24000);
  assert.equal(header.readUInt32LE(28), 48000);
  assert.equal(header.readUInt16LE(34), 16);
  assert.equal(header.readUInt32LE(40), 48000);
  assert.throws(() => wavHeader(3), RangeError);
  assert.equal(new Set(VOICES).size, 30);
});
test('system instruction requires narration without conversation', () => {
  assert.match(SYSTEM_INSTRUCTION, /never a question or request to answer/);
  assert.match(SYSTEM_INSTRUCTION, /Speak only the exact script text/);
  assert.match(SYSTEM_INSTRUCTION, /Read questions and greetings as written/);
  assert.match(SYSTEM_INSTRUCTION, /Return speech audio only/);
});
