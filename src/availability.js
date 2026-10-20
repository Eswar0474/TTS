export function getAvailability({
  configStatus, configured, voices = [], generating, selectedModel, voice, text,
  overLimit, overDailyLimit, signedIn, admin, userPlan
}) {
  const voiceDisabled = generating || configStatus !== 'ready' || !voices.length;
  let reason = '';
  const isPaid = ['plus', 'pro', 'studio'].includes(userPlan);
  const hasEnhanced = admin || ['pro', 'studio'].includes(userPlan);
  if (generating) reason = 'Generation is in progress.';
  else if (configStatus === 'loading') reason = 'Checking server configuration…';
  else if (configStatus !== 'ready') reason = 'Cannot reach a valid server configuration. Retry configuration above.';
  else if (!configured) reason = 'Backend setup required: set GEMINI_API_KEY in the project’s .env file, verify the model setting, restart the backend, then click Retry configuration. Do not enter your key here.';
  else if (!selectedModel || !voice) reason = 'Select an engine and voice.';
  else if (selectedModel.requiresLogin && !signedIn) reason = 'Sign in with Google to use the Balanced model.';
  else if (selectedModel.requiresAdmin && !hasEnhanced) reason = 'Enhanced Thinking is temporarily available to admins only or Pro/Studio plans.';
  else if (overLimit) reason = 'Shorten your script to fit this engine’s application character cap.';
  else if (overDailyLimit) reason = 'Shorten your script to fit the remaining daily word allowance.';
  else if (!text.trim()) reason = 'Write your script or click Use sample to enable generation.';
  return { voiceDisabled, generateDisabled: Boolean(reason), reason };
}
