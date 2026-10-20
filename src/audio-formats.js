export const AUDIO_FORMATS = Object.freeze({
  mp3: { label: 'MP3', extension: 'mp3', mimeType: 'audio/mpeg' },
  wav: { label: 'WAV', extension: 'wav', mimeType: 'audio/wav' },
  flac: { label: 'FLAC', extension: 'flac', mimeType: 'audio/flac' },
  aac: { label: 'AAC', extension: 'aac', mimeType: 'audio/aac' },
  ogg: { label: 'OGG', extension: 'ogg', mimeType: 'audio/ogg' }
});

export const PLAN_FORMATS = Object.freeze({
  free: Object.freeze(['mp3']),
  plus: Object.freeze(['mp3', 'aac', 'ogg']),
  pro: Object.freeze(['mp3', 'aac', 'ogg', 'flac']),
  studio: Object.freeze(['mp3', 'aac', 'ogg', 'flac', 'wav'])
});

export const FORMAT_MIN_PLAN = Object.freeze({
  mp3: 'Free',
  aac: 'Plus',
  ogg: 'Plus',
  flac: 'Pro',
  wav: 'Studio'
});

export function isFormatAllowed(format, userPlan = 'free', isAdmin = false) {
  if (isAdmin) return true;
  const plan = (userPlan || 'free').toLowerCase();
  const allowed = PLAN_FORMATS[plan] || PLAN_FORMATS.free;
  return allowed.includes(format);
}

export function transcodeArguments(format, inputName, outputName) {
  if (!Object.hasOwn(AUDIO_FORMATS, format)) throw new RangeError(`Unsupported audio format: ${format}`);
  if (format === 'mp3') return ['-i', inputName, '-vn', '-c:a', 'libmp3lame', '-b:a', '192k', outputName];
  if (format === 'flac') return ['-i', inputName, '-vn', '-c:a', 'flac', outputName];
  if (format === 'aac') return ['-i', inputName, '-vn', '-c:a', 'aac', '-b:a', '192k', '-f', 'adts', outputName];
  if (format === 'ogg') return ['-i', inputName, '-vn', '-c:a', 'libvorbis', '-q:a', '5', '-f', 'ogg', outputName];
  return ['-i', inputName, '-vn', '-c:a', 'pcm_s16le', outputName];
}
