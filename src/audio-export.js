import coreURL from '@ffmpeg/core?url';
import wasmURL from '@ffmpeg/core/wasm?url';
import { AUDIO_FORMATS, transcodeArguments } from './audio-formats.js';

export { AUDIO_FORMATS } from './audio-formats.js';

let ffmpegPromise;

async function getFFmpeg() {
  if (!ffmpegPromise) {
    ffmpegPromise = (async () => {
      const { FFmpeg } = await import('@ffmpeg/ffmpeg');
      const ffmpeg = new FFmpeg();
      await ffmpeg.load({ coreURL, wasmURL });
      return ffmpeg;
    })();
  }
  try {
    return await ffmpegPromise;
  } catch (error) {
    ffmpegPromise = undefined;
    throw error;
  }
}

export async function transcodeAudio(wavBytes, format) {
  if (!(wavBytes instanceof Uint8Array) || !wavBytes.byteLength) throw new TypeError('A non-empty WAV file is required.');
  if (!Object.hasOwn(AUDIO_FORMATS, format)) throw new RangeError(`Unsupported audio format: ${format}`);
  if (format === 'wav') return wavBytes;

  const ffmpeg = await getFFmpeg();
  const inputName = `sonora-input-${crypto.randomUUID()}.wav`;
  const outputName = `sonora-output-${crypto.randomUUID()}.${AUDIO_FORMATS[format].extension}`;
  await ffmpeg.writeFile(inputName, wavBytes.slice());
  try {
    const exitCode = await ffmpeg.exec(transcodeArguments(format, inputName, outputName));
    if (exitCode !== 0) throw new Error(`Audio conversion to ${AUDIO_FORMATS[format].label} failed.`);
    const result = await ffmpeg.readFile(outputName);
    if (!(result instanceof Uint8Array) || !result.byteLength) throw new Error('Audio conversion returned an empty file.');
    return result;
  } finally {
    await ffmpeg.deleteFile(inputName);
    if (ffmpeg.listDir) {
      const files = await ffmpeg.listDir('/');
      if (files.some((file) => file.name === outputName)) await ffmpeg.deleteFile(outputName);
    }
  }
}
