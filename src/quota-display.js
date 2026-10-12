export function formatResetCountdown(resetsAt, now = Date.now()) {
  const resetTime = Date.parse(resetsAt);
  if (!Number.isFinite(resetTime) || !Number.isFinite(now)) throw new TypeError('A valid reset time and current time are required.');
  const seconds = Math.max(0, Math.ceil((resetTime - now) / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainingSeconds = seconds % 60;
  return [hours, minutes, remainingSeconds].map(value => String(value).padStart(2, '0')).join(':');
}
