import test from 'node:test';
import assert from 'node:assert/strict';
import { AUDIO_FORMATS, transcodeArguments } from '../src/audio-formats.js';
import { formatResetCountdown } from '../src/quota-display.js';

test('audio export formats map to named files and supported encoder arguments', () => {
  assert.deepEqual(Object.keys(AUDIO_FORMATS), ['mp3', 'wav', 'flac', 'aac', 'ogg']);
  assert.equal(AUDIO_FORMATS.mp3.mimeType, 'audio/mpeg');
  assert.deepEqual(transcodeArguments('mp3', 'in.wav', 'out.mp3'), [
    '-i', 'in.wav', '-vn', '-c:a', 'libmp3lame', '-b:a', '192k', 'out.mp3'
  ]);
  assert.deepEqual(transcodeArguments('flac', 'in.wav', 'out.flac'), [
    '-i', 'in.wav', '-vn', '-c:a', 'flac', 'out.flac'
  ]);
  assert.deepEqual(transcodeArguments('aac', 'in.wav', 'out.aac'), [
    '-i', 'in.wav', '-vn', '-c:a', 'aac', '-b:a', '192k', '-f', 'adts', 'out.aac'
  ]);
  assert.deepEqual(transcodeArguments('ogg', 'in.wav', 'out.ogg'), [
    '-i', 'in.wav', '-vn', '-c:a', 'libvorbis', '-q:a', '5', '-f', 'ogg', 'out.ogg'
  ]);
  assert.throws(() => transcodeArguments('unknown', 'in.wav', 'out'), /Unsupported audio format/);
});

test('daily reset countdown formats hours, minutes, seconds, and expiry', () => {
  const now = Date.parse('2026-10-12T10:00:00Z');
  assert.equal(formatResetCountdown('2026-10-12T11:02:03Z', now), '01:02:03');
  assert.equal(formatResetCountdown('2026-10-12T09:59:59Z', now), '00:00:00');
  assert.throws(() => formatResetCountdown('not-a-date', now), /valid reset time/);
});
