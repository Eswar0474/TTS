import test from 'node:test';
import assert from 'node:assert/strict';
import { getAvailability } from '../src/availability.js';

const ready = { configStatus: 'ready', configured: true, voices: ['Kore', 'Puck'], generating: false, selectedModel: { id: 'test' }, voice: 'Kore', text: 'Hello.', overLimit: false };
test('voices stay selectable when credentials are missing, generation explains setup', () => {
  const state = getAvailability({ ...ready, configured: false });
  assert.equal(state.voiceDisabled, false);
  assert.equal(state.generateDisabled, true);
  assert.match(state.reason, /GEMINI_API_KEY/);
});
test('valid configured input enables generation', () => {
  assert.equal(getAvailability(ready).generateDisabled, false);
});
test('empty input, limits, loading, and active requests explain disabled controls', () => {
  for (const overrides of [{ text: '  ' }, { overLimit: true }, { configStatus: 'loading' }, { generating: true }, { voice: '' }]) {
    const state = getAvailability({ ...ready, ...overrides });
    assert.equal(state.generateDisabled, true);
    assert.ok(state.reason.length);
  }
  assert.equal(getAvailability({ ...ready, generating: true }).voiceDisabled, true);
  assert.equal(getAvailability({ ...ready, voices: [] }).voiceDisabled, true);
});

test('requests above the remaining daily word allowance are disabled', () => {
  const state = getAvailability({ ...ready, overDailyLimit: true });
  assert.equal(state.generateDisabled, true);
  assert.match(state.reason, /daily word allowance/i);
});

test('Balanced requires sign-in and Enhanced Thinking is admin-only', () => {
  const balanced = { id: 'balanced', requiresLogin: true, requiresAdmin: false };
  const guest = getAvailability({ ...ready, selectedModel: balanced, signedIn: false, admin: false });
  assert.equal(guest.generateDisabled, true);
  assert.match(guest.reason, /sign in with Google/i);
  assert.equal(getAvailability({
    ...ready,
    selectedModel: balanced,
    signedIn: true,
    admin: false
  }).generateDisabled, false);

  const enhanced = { id: 'enhanced', requiresLogin: false, requiresAdmin: true };
  const freeUser = getAvailability({ ...ready, selectedModel: enhanced, signedIn: true, admin: false });
  assert.equal(freeUser.generateDisabled, true);
  assert.match(freeUser.reason, /admins only/i);
  assert.equal(getAvailability({
    ...ready,
    selectedModel: enhanced,
    signedIn: true,
    admin: true
  }).generateDisabled, false);
});
