import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { SAMPLE_RATE, decodeBase64PCM } from './audio.js';
import './styles.css';
import './stream.css';
import { getAvailability } from './availability.js';
import { countRequestWords, getRequestWordLimit, validateConfig } from './config.js';
import { buildModulatedText } from './expression.js';
import { getModelPresentation, VOICE_LABELS } from './presentation.js';
import { AUDIO_FORMATS, isFormatAllowed } from './audio-formats.js';
import { createAudioStore, nextSessionId } from './audio-store.js';
import { isValidStreamStart, readNDJSONStream } from './stream-client.js';
import { errorMessage } from './export-errors.js';
import { estimateGenerationSeconds, formatApproximateDuration, formatElapsedTime, getRequestTiming } from './timing.js';

const SAMPLE = 'The future is not a destination. It is a rhythm we learn to move with.';
const canShareFile = (file) => {
  if (!file || typeof navigator.share !== 'function' || typeof navigator.canShare !== 'function') return false;
  try { return navigator.canShare({ files: [file] }); }
  catch { return false; }
};

function App() {
  const [text, setText] = useState('');
  const [expressionTags, setExpressionTags] = useState('Enthusiast, Excitement');
  const [config, setConfig] = useState(null);
  const [configStatus, setConfigStatus] = useState('loading');
  const [configError, setConfigError] = useState('');
  const [voice, setVoice] = useState('');
  const [modelId, setModelId] = useState('');
  const [status, setStatus] = useState('idle');
  const [audioUrl, setAudioUrl] = useState('');
  const [audioFormat, setAudioFormat] = useState('mp3');
  const [downloading, setDownloading] = useState(false);
  const [preparedExport, setPreparedExport] = useState(null);
  const [downloadError, setDownloadError] = useState('');
  const [authPrompt, setAuthPrompt] = useState(null);
  const [requestTiming, setRequestTiming] = useState(null);
  const [clockNow, setClockNow] = useState(Date.now());
  const [error, setError] = useState('');
  const [authActionError, setAuthActionError] = useState('');
  const [progress, setProgress] = useState({ completed: 0, total: 0 });
  const requestRef = useRef(null);
  const configRequestRef = useRef(null);
  const audioUrlRef = useRef('');
  const preparedExportRef = useRef(null);
  const wavBytesRef = useRef(null);
  const downloadLockRef = useRef(false);
  const authPopupRequestedRef = useRef(false);
  const mountedRef = useRef(true);
  const selectionRef = useRef({ modelId: '', voice: '' });

  function clearFile() {
    if (audioUrlRef.current) URL.revokeObjectURL(audioUrlRef.current);
    audioUrlRef.current = '';
    wavBytesRef.current = null;
    setAudioUrl('');
    clearPreparedExport();
  }

  function clearPreparedExport() {
    if (preparedExportRef.current?.url) URL.revokeObjectURL(preparedExportRef.current.url);
    preparedExportRef.current = null;
    setPreparedExport(null);
  }

  function resetOutput() {
    clearFile(); setStatus('idle'); setError('');
    setRequestTiming(null);
    setProgress({ completed: 0, total: 0 });
  }

  function changeSelection(key, value) {
    if (requestRef.current || selectionRef.current[key] === value) return;
    const model = config?.models.find((item) => item.id === value);
    if (key === 'modelId' && model?.requiresLogin && !config?.auth.signedIn) {
      setAuthPrompt('model');
      return;
    }
    resetOutput();
    selectionRef.current = { ...selectionRef.current, [key]: value };
    if (key === 'modelId') setModelId(value);
    else setVoice(value);
  }

  async function loadConfig() {
    if (requestRef.current) return;
    configRequestRef.current?.abort();
    const controller = new AbortController();
    configRequestRef.current = controller;
    setConfigStatus('loading'); setConfigError('');
    try {
      const response = await fetch('/api/config', { signal: controller.signal });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Unable to load server configuration.');
      validateConfig(data);
      if (controller.signal.aborted || !mountedRef.current || configRequestRef.current !== controller) return;
      const previous = selectionRef.current;
      const previousModel = data.models.find((model) => model.id === previous.modelId);
      const nextModelId = previousModel &&
        (!previousModel.requiresLogin || data.auth.signedIn)
        ? previous.modelId
        : data.defaultModelId || data.modelId || data.models[0].id;
      const nextVoice = data.voices.includes(previous.voice) ? previous.voice : data.voices.includes('Kore') ? 'Kore' : data.voices[0] || '';
      if (previous.modelId !== nextModelId || previous.voice !== nextVoice) resetOutput();
      selectionRef.current = { modelId: nextModelId, voice: nextVoice };
      setConfig(data); setModelId(nextModelId); setVoice(nextVoice);
      if (data.auth.signedIn) setAuthPrompt(null);
      setConfigStatus('ready');
    } catch (err) {
      if (controller.signal.aborted || !mountedRef.current || configRequestRef.current !== controller) return;
      setConfig(null); setConfigStatus('error'); setConfigError(err.message);
    }
  }

  async function signOut() {
    setAuthActionError('');
    try {
      const response = await fetch('/api/auth/logout', { method: 'POST' });
      if (!response.ok) throw new Error('Sign-out could not be completed. Please try again.');
      await loadConfig();
      setAudioFormat('mp3');
      clearPreparedExport();
      setAuthPrompt(null);
    } catch (err) {
      setAuthActionError(err.message);
    }
  }

  useEffect(() => {
    mountedRef.current = true;
    void loadConfig();
    return () => {
      mountedRef.current = false;
      requestRef.current?.abort(); configRequestRef.current?.abort();
      if (audioUrlRef.current) URL.revokeObjectURL(audioUrlRef.current);
      if (preparedExportRef.current?.url) URL.revokeObjectURL(preparedExportRef.current.url);
    };
  }, []);

  useEffect(() => {
    const onFocus = () => {
      if (!authPopupRequestedRef.current) return;
      authPopupRequestedRef.current = false;
      void loadConfig();
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, []);

  const generating = status === 'generating';
  const busy = generating || downloading;
  const signedIn = Boolean(config?.auth.signedIn);
  const verifiedAdmin = config?.auth?.signedIn === true && config?.auth?.admin === true;
  const selectedModel = config?.models.find((model) => model.id === modelId);
  const modelPresentation = selectedModel ? getModelPresentation(selectedModel) : null;
  const characterLimit = selectedModel?.characterLimit;
  const wordLimit = getRequestWordLimit(selectedModel, config?.auth, config?.guestWordLimit);
  const hasWordLimit = Number.isSafeInteger(wordLimit) && wordLimit > 0;
  const formattedWordLimit = hasWordLimit ? wordLimit.toLocaleString() : '—';
  const requestText = useMemo(() => buildModulatedText(text, expressionTags), [text, expressionTags]);
  const characterCount = requestText.length;
  const wordCount = useMemo(() => countRequestWords(requestText), [requestText]);
  const overWordLimit = hasWordLimit && wordCount > wordLimit;
  const overCharacterLimit = characterLimit != null && characterCount > characterLimit;
  const percent = hasWordLimit ? Math.min((wordCount / wordLimit) * 100, 100) : 0;
  const estimatedSeconds = useMemo(() => text.trim() ? estimateGenerationSeconds(requestText, modelId) : 0, [text, requestText, modelId]);
  const timing = getRequestTiming(requestTiming, clockNow);
  const ready = configStatus === 'ready' && config?.configured && voice && selectedModel;
  const progressPercent = progress.total ? Math.round((progress.completed / progress.total) * 100) : 0;
  const canSharePreparedExport = canShareFile(preparedExport?.file);
  const availability = getAvailability({
    configStatus,
    configured: config?.configured,
    voices: config?.voices,
    generating: busy,
    selectedModel,
    voice,
    text,
    overWordLimit,
    overCharacterLimit,
    signedIn,
    wordLimit
  });

  useEffect(() => {
    if (!isFormatAllowed(audioFormat, signedIn)) {
      clearPreparedExport();
      setAudioFormat('mp3');
    }
  }, [signedIn, audioFormat]);

  useEffect(() => {
    if (!generating) return;
    const timer = setInterval(() => setClockNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [generating]);

  useEffect(() => {
    if (!authPrompt) return;
    const closeOnEscape = (event) => {
      if (event.key === 'Escape') setAuthPrompt(null);
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [authPrompt]);

  function selectAudioFormat(format) {
    if (!Object.hasOwn(AUDIO_FORMATS, format)) return;
    if (!isFormatAllowed(format, signedIn)) {
      setAuthPrompt('formats');
      return;
    }
    setDownloadError('');
    clearPreparedExport();
    setAudioFormat(format);
  }

  async function downloadAudio() {
    if (downloadLockRef.current || !wavBytesRef.current) return;
    if (!isFormatAllowed(audioFormat, signedIn)) {
      setAuthPrompt('formats');
      return;
    }
    downloadLockRef.current = true;
    setDownloading(true);
    setDownloadError('');
    try {
      const formatKey = audioFormat;
      const sourceWav = wavBytesRef.current;
      if (!(sourceWav instanceof Uint8Array) || !sourceWav.byteLength) {
        throw new Error('The generated audio is no longer available. Generate it again.');
      }
      // WAV is already the generated output. Keep it independent of the
      // optional FFmpeg/WebAssembly encoder so a CSP or encoder-load problem
      // cannot block the lossless download path.
      const bytes = formatKey === 'wav'
        ? sourceWav
        : await (await import('./audio-export.js')).transcodeAudio(sourceWav, formatKey);
      const format = AUDIO_FORMATS[formatKey];
      const filename = `sonora-speech.${format.extension}`;
      const blob = new Blob([bytes], { type: format.mimeType });
      const file = typeof File === 'function' ? new File([blob], filename, { type: format.mimeType }) : null;
      const nextExport = {
        url: URL.createObjectURL(blob),
        filename,
        format: formatKey,
        file
      };
      clearPreparedExport();
      preparedExportRef.current = nextExport;
      setPreparedExport(nextExport);
    } catch (err) {
      setDownloadError(errorMessage(err));
    } finally {
      downloadLockRef.current = false;
      setDownloading(false);
    }
  }

  async function sharePreparedExport() {
    const file = preparedExport?.file;
    if (!file || typeof navigator.share !== 'function' ||
        typeof navigator.canShare !== 'function' || !navigator.canShare({ files: [file] })) {
      setDownloadError('File sharing is not supported here. Use the Save file link instead.');
      return;
    }
    setDownloadError('');
    try {
      await navigator.share({ files: [file], title: 'Sonora speech' });
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') return;
      setDownloadError(errorMessage(err, 'The file could not be shared.'));
    }
  }

  function cancel() {
    const controller = requestRef.current;
    requestRef.current = null;
    setRequestTiming((previous) => previous && !previous.finishedAt ? { ...previous, finishedAt: Date.now() } : previous);
    controller?.abort(); clearFile(); setStatus('cancelled'); setError('');
  }

  async function generate() {
    if (requestRef.current || downloadLockRef.current || !ready) return;
    setError('');
    if (!text.trim()) return setError('Add some text before generating audio.');
    if (selectedModel.requiresLogin && !signedIn) { setAuthPrompt('model'); return; }
    if (hasWordLimit && overWordLimit) return setError(`Limit: ${formattedWordLimit} words per request, including tags.`);
    if (overCharacterLimit) return setError(`Limit: ${characterLimit.toLocaleString()} characters per request.`);
    clearFile();
    const controller = new AbortController();
    requestRef.current = controller;
    const startedAt = Date.now();
    setClockNow(startedAt);
    setRequestTiming({ startedAt, finishedAt: null, estimateSeconds: estimatedSeconds });
    setStatus('generating'); setProgress({ completed: 0, total: 0 });
    let reader;
    // Create a fresh IndexedDB-backed store for this generation session.
    const audioStore = createAudioStore(nextSessionId());
    const current = () => mountedRef.current && requestRef.current === controller && !controller.signal.aborted;
    let streamEnded = false;
    try {
      const response = await fetch('/api/generate/stream', {
        method: 'POST',
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: requestText, model: modelId, voice })
      });
      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || 'Generation failed.');
      }
      if (!response.body) throw new Error('Streaming responses are not supported in this browser.');
      reader = response.body.getReader();
      let started = false, done = false, total = 0, completed = 0;
      const stream = await readNDJSONStream(reader, {
        isActive: current,
        onEvent: (event) => {
          if (!current()) return;
          if (done) throw new Error('Received an event after stream completion.');
          if (event.type === 'start') {
            if (started || !isValidStreamStart(event)) throw new Error('Invalid stream start.');
            started = true; total = event.totalChunks; setProgress({ completed: 0, total }); return;
          }
          if (!started) throw new Error('Audio stream did not begin with a start event.');
          if (event.type === 'audio') {
            const pcm = decodeBase64PCM(event.data);
            // Persist received PCM; server PCM and cumulative wire caps still apply.
            audioStore.appendChunk(pcm);
          } else if (event.type === 'progress') {
            if (event.totalChunks !== total || !Number.isInteger(event.completedChunks) || event.completedChunks < completed || event.completedChunks > total) throw new Error('Invalid stream progress.');
            completed = event.completedChunks; setProgress({ completed, total });
          } else if (event.type === 'done') {
            if (completed !== total || !audioStore.totalBytes) throw new Error('The audio stream is incomplete.');
            done = true;
          }
          else throw new Error('Unknown stream event.');
        }
      });
      streamEnded = stream.ended;
      if (stream.error) throw stream.error;
      if (!done) throw new Error('The audio stream ended before completion. Please retry.');
      // Assemble the complete WAV from stored chunks into one Uint8Array.
      const wav = await audioStore.buildWav(SAMPLE_RATE);
      if (!current()) return;
      wavBytesRef.current = wav;
      audioUrlRef.current = URL.createObjectURL(new Blob([wav], { type: 'audio/wav' }));
      setRequestTiming((previous) => previous?.startedAt === startedAt ? { ...previous, finishedAt: Date.now() } : previous);
      setAudioUrl(audioUrlRef.current); setStatus('complete'); setProgress({ completed: total, total });
    } catch (err) {
      if (!current()) return;
      if (!streamEnded) controller.abort();
      setRequestTiming((previous) => previous?.startedAt === startedAt ? { ...previous, finishedAt: Date.now() } : previous);
      clearFile(); setError(err instanceof Error ? err.message : 'Generation failed.'); setStatus('error');
    } finally {
      if (reader && !streamEnded) { try { await reader.cancel(); } catch {} }
      // Clean partial storage on cancellation as well as success/error.
      await audioStore.clear();
      if (requestRef.current === controller) requestRef.current = null;
    }
  }

  return <div className="app-shell">
      <header className="topbar"><div className="brand"><span className="brand-mark">◒</span><span>sonora</span><span className="badge">VOICE STUDIO</span></div><div className="topbar-right"><span>Text-to-speech workspace</span><a className="help-link" href="/how-it-works">How it works &amp; FAQ</a>{signedIn
       ? <button className="account-button" disabled={busy} onClick={signOut}>Sign out</button>
      : config?.auth.enabled
        ? <a className="account-button" href="/auth/google">Sign in with Google</a>
        : <button className="account-button" disabled title="Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and GOOGLE_REDIRECT_URI in Render to enable Google sign-in.">Sign in with Google</button>}</div>{authActionError && <p className="auth-error" role="alert">{authActionError}</p>}</header>
    <main className="workspace">
      <section className="hero" id="studio"><div><p className="eyebrow">SONORA · CREATIVE AUDIO</p><h1>AI text to speech<br /><em>with Sonora.</em></h1><p className="hero-copy">Turn your script into expressive voice narration. Choose a voice, guide its delivery with tags, preview the result, and export audio.</p></div><div className="hero-orb"><div className="orb-core" /><div className="wave wave-one" /><div className="wave wave-two" /><div className="wave wave-three" /></div></section>
      <section className="studio-grid">
         <div className="panel input-panel">
            <div className="panel-heading"><div><span className="step">01</span><h2>Write your script</h2></div><button className="sample-button" disabled={busy} onClick={() => setText(SAMPLE)}>Use sample <span>↗</span></button></div>
            <div className="expression-bar"><label className="expression-entry"><span className="expression-label">EMOTION & DELIVERY TAGS</span><input aria-label="Emotion and delivery tags" type="text" value={expressionTags} disabled={busy} onChange={(e) => setExpressionTags(e.target.value)} placeholder="e.g. Warm, excited, whispering" /><small>{buildModulatedText('', expressionTags).trim() || 'No tags added'}</small></label></div>
            <p className="expression-hint">Add tags separated by commas.</p>
             <div className="textarea-wrap"><textarea aria-label="Script" disabled={busy} onChange={(e) => setText(e.target.value)} value={text} placeholder="Write or paste your script…" /><div className="textarea-footer"><span className={verifiedAdmin && selectedModel ? 'word-counter admin' : overWordLimit ? 'word-counter over' : 'word-counter'} aria-label={verifiedAdmin && selectedModel ? `${wordCount.toLocaleString()} words, including tags. Admin · no word limit per request.` : `${wordCount.toLocaleString()} of ${hasWordLimit ? formattedWordLimit : 'unknown'} words per request, including tags`}>{verifiedAdmin && selectedModel ? <>{wordCount.toLocaleString()} words · Admin · no word limit <span>per request · incl. tags</span></> : <>{wordCount.toLocaleString()} / {formattedWordLimit} words <span>per request · incl. tags</span></>}</span><span className={overCharacterLimit ? 'counter over' : 'counter'}>{characterCount.toLocaleString()} <span>/ {characterLimit?.toLocaleString() || '—'} characters</span></span></div></div>
              {hasWordLimit && <div className="request-limit-track" aria-hidden="true"><div style={{ width: `${percent}%` }} /></div>}
              <p className="request-guidance">{verifiedAdmin && selectedModel ? 'No daily quota. Admin word-limit exemption applies to each request; character and audio safety limits still apply.' : 'No daily quota. The word limit applies to each request separately.'}</p>
            {!signedIn && configStatus === 'ready' && <p className="request-guidance">Guests can use Low Quality with up to {config.guestWordLimit.toLocaleString()} words per request. <button className="inline-sign-in" onClick={() => setAuthPrompt('model')}>Sign in for Balanced, Enhanced Thinking, and higher limits</button>.</p>}
             {hasWordLimit && overWordLimit && <p className="error-text" role="status">{signedIn ? `This engine allows ${formattedWordLimit} words per request, including tags. Shorten your script.` : `The guest limit is ${formattedWordLimit} words per request, including tags. Shorten your script or sign in.`}</p>}
            {overCharacterLimit && <p className="error-text" role="status">Character safety limit reached. Shorten your script to {characterLimit.toLocaleString()} characters.</p>}
         </div>
        <aside className="panel settings-panel">
          <div className="panel-heading"><div><span className="step">02</span><h2>Voice settings</h2></div><span className="live-pill">STUDIO</span></div>
           <label>ENGINE<select value={selectedModel ? modelId : ''} disabled={busy || configStatus !== 'ready'} onChange={(e) => changeSelection('modelId', e.target.value)} aria-describedby="engine-description">
             {!selectedModel && <option value="">{configStatus === 'loading' ? 'Loading engines…' : 'No engines available'}</option>}
              {(config?.models || []).map((model) => <option key={model.id} value={model.id}>{getModelPresentation(model).name}{model.requiresLogin && !signedIn ? ' · Sign in' : ''}</option>)}
            </select></label>
            {selectedModel && modelPresentation && <div className="engine-description" id="engine-description">
               <div className="model-profile"><strong>{modelPresentation.profile}</strong><span>{verifiedAdmin ? 'Admin · no word limit' : hasWordLimit ? `${formattedWordLimit} words per request` : 'Word limit unavailable'} · {selectedModel.characterLimit.toLocaleString()} character safety cap</span></div>
            </div>}
           <p className="model-note">AI may not produce the exact output you expect.</p>
          <div className="config-status" role="status"><p>{configStatus === 'loading' ? 'Checking server configuration…' : configError || (config?.configured ? 'Server configured · Streaming available' : 'Server is not configured. Set up the server, then retry.')}</p><button className="sample-button" disabled={busy || configStatus === 'loading'} onClick={loadConfig}>Retry configuration ↗</button></div>
           <label>VOICE<select value={voice} disabled={availability.voiceDisabled} onChange={(e) => changeSelection('voice', e.target.value)}>{!voice && <option value="">No voices available</option>}{(config?.voices || []).map((item) => <option key={item} value={item}>{VOICE_LABELS[item] || 'Studio voice'}</option>)}</select></label>
           <div className="voice-preview"><div className="avatar">{VOICE_LABELS[voice]?.slice(0, 1) || '—'}</div><div><strong>{VOICE_LABELS[voice] || 'Choose a voice'}</strong><small>Studio voice</small></div><div className="mini-wave">▁▃▆▃▅▂▃</div></div>
           <p className="estimate-note" role="status">{text.trim() ? <>Approx. generation time: <strong>{formatApproximateDuration(generating && requestTiming ? requestTiming.estimateSeconds : estimatedSeconds)}</strong><span>Estimate only; synthesis may take longer.</span></> : 'Add a script to see an approximate generation time.'}</p>
           <button className="generate-button" disabled={availability.generateDisabled} aria-describedby="generation-requirements" onClick={generate}>{generating ? <><span className="spinner" /> Synthesizing…</> : <>Generate audio <span>→</span></>}</button>
          <p id="generation-requirements" className="engine-description" role="status">{availability.reason || 'Ready.'}</p>
          {error && <p className="error-text" role="alert">{error}</p>}
        </aside>
      </section>
      <section className={`output-panel ${audioUrl ? 'has-audio' : ''} ${generating ? 'is-generating' : ''}`}>
        <div className="output-label"><span className="step">03</span><div><h2>{audioUrl ? 'Preview your narration' : 'Audio output'}</h2><p role="status">{generating ? `Generating audio · ${progress.completed} of ${progress.total || '…'} segments complete` : audioUrl ? 'Preview the audio below, choose a format, and download.' : status === 'cancelled' ? 'Generation cancelled · No partial file saved' : status === 'error' ? 'Generation failed · No partial file saved' : 'Your completed audio will be available here.'}</p></div></div>
         {timing && <p className="elapsed-note" role="timer">{generating ? <>Elapsed: {formatElapsedTime(timing.elapsedSeconds)} · {timing.takingLonger ? 'Taking longer than the approximate estimate…' : `Approx. request estimate: ${formatApproximateDuration(requestTiming.estimateSeconds)}`}</> : status === 'complete' ? `Completed in ${formatElapsedTime(timing.elapsedSeconds)}` : status === 'cancelled' ? `Cancelled after ${formatElapsedTime(timing.elapsedSeconds)}` : `Stopped after ${formatElapsedTime(timing.elapsedSeconds)}`}</p>}
         {generating && <div className="generation-progress"><div className="progress-caption"><span>Generation progress</span><strong>{progressPercent}%</strong></div><progress aria-label="Generation progress" value={progressPercent} max="100" /></div>}
         <div className="output-controls">{generating && <button className="cancel-button" onClick={cancel}>Cancel generation</button>}{audioUrl && <><audio controls preload="metadata" src={audioUrl} aria-label="Preview completed narration" /><label className="format-picker">DOWNLOAD FORMAT<select aria-label="Download format" value={audioFormat} disabled={downloading || configStatus !== 'ready'} onChange={(event) => selectAudioFormat(event.target.value)}>{Object.entries(AUDIO_FORMATS).map(([format, details]) => <option key={format} value={format}>{details.label}{isFormatAllowed(format, signedIn) ? '' : ' · Sign in'}</option>)}</select></label>{preparedExport?.format === audioFormat ? <><a className="download-button" href={preparedExport.url} download={preparedExport.filename}>Save {AUDIO_FORMATS[audioFormat].label} file ↓</a>{canSharePreparedExport && <button className="download-button" onClick={sharePreparedExport}>Share / Save file ↗</button>}</> : <button className="download-button" disabled={downloading} onClick={downloadAudio}>{downloading ? 'Preparing…' : `Prepare ${AUDIO_FORMATS[audioFormat].label} ↓`}</button>}</>}</div>
        {preparedExport?.format === audioFormat && <p className="format-note" role="status">Your {AUDIO_FORMATS[audioFormat].label} is ready. Tap Save file, or use Share / Save on supported phones.</p>}
         {audioUrl && !preparedExport && <p className="format-note">{audioFormat === 'wav' ? 'WAV is ready without conversion.' : 'First conversion loads the audio encoder (~32 MB). Conversion runs in your browser; audio stays on your device.'} On phones, tap Prepare, then Save file or Share / Save.</p>}
        {downloadError && <p className="error-text download-error" role="alert">{downloadError}</p>}
        {!audioUrl && !generating && <div className="empty-wave">{[...Array(32)].map((_, i) => <i key={i} style={{ height: `${10 + (i * 17) % 38}px` }} />)}</div>}
      </section>
    </main>
    {authPrompt && <div className="auth-modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setAuthPrompt(null); }}><section className="auth-modal" role="dialog" aria-modal="true" aria-labelledby="auth-modal-title"><button className="modal-close" aria-label="Close dialog" onClick={() => setAuthPrompt(null)}>×</button><span className="modal-eyebrow">{authPrompt === 'model' ? 'MODEL ACCESS' : 'MORE AUDIO FORMATS'}</span><h2 id="auth-modal-title">Sign in with Google</h2><p>{authPrompt === 'model' ? 'Guests can use Low Quality for up to 50 words per request. Sign in for Balanced and Enhanced Thinking, with higher per-request limits.' : 'Guests can prepare and download MP3. Sign in to use WAV, FLAC, AAC, and OGG too.'}</p>{config?.auth.enabled ? <a className="account-button modal-sign-in" href="/auth/google" target="_blank" rel="noreferrer" onClick={() => { authPopupRequestedRef.current = true; }}>Sign in with Google</a> : <button className="account-button modal-sign-in" disabled title="Google sign-in is not configured on this server.">Google sign-in unavailable</button>}<button className="modal-dismiss" onClick={() => setAuthPrompt(null)}>Continue as guest</button></section></div>}
  </div>;
}
createRoot(document.getElementById('root')).render(<App />);
