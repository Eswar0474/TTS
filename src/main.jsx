import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { SAMPLE_RATE, MAX_AUDIO_BYTES, MAX_STREAM_WIRE_BYTES, decodeBase64PCM, encodeWav, createNDJSONParser } from './audio.js';
import './styles.css';
import './stream.css';
import { getAvailability } from './availability.js';
import { buildModulatedText } from './expression.js';
import { getModelPresentation, VOICE_LABELS } from './presentation.js';
import { AUDIO_FORMATS, isFormatAllowed, FORMAT_MIN_PLAN } from './audio-formats.js';
import { formatResetCountdown } from './quota-display.js';

const SAMPLE = 'The future is not a destination. It is a rhythm we learn to move with.';
const ALLOWED_QUOTA_LIMITS = [50, 1000, 2000, 3000, 5000, 1000000];
const canShareFile = (file) => {
  if (!file || typeof navigator.share !== 'function' || typeof navigator.canShare !== 'function') return false;
  try { return navigator.canShare({ files: [file] }); }
  catch { return false; }
};
const validDailyWordQuota = (quota) => quota && ALLOWED_QUOTA_LIMITS.includes(quota.limit) &&
  Number.isSafeInteger(quota.used) && quota.used >= 0 && quota.used <= quota.limit &&
  quota.remaining === quota.limit - quota.used &&
  (quota.unlimited === undefined || typeof quota.unlimited === 'boolean') &&
  (quota.unlimited !== true || [1000, 2000, 3000, 5000, 1000000].includes(quota.limit)) &&
  typeof quota.resetsAt === 'string' && Number.isFinite(Date.parse(quota.resetsAt));

function validateConfig(data) {
  const nonempty = (value) => typeof value === 'string' && value.trim().length > 0;
  const positiveLimit = (value) => Number.isSafeInteger(value) && value > 0;
  const userPlan = (data?.user?.plan || 'free').toLowerCase();
  const isStudio = userPlan === 'studio';
  const expectedLimit = isStudio ? 5000 : userPlan === 'pro' ? 3000 : userPlan === 'plus' ? 2000 : data?.auth?.signedIn ? 1000 : 50;
  const expectedUnlimited = Boolean(data?.auth?.admin);
  if (!data || typeof data.configured !== 'boolean' || !positiveLimit(data.characterLimit) || data.streaming !== true ||
    !validDailyWordQuota(data.dailyWordQuota) ||
    !data.auth || typeof data.auth.enabled !== 'boolean' || typeof data.auth.signedIn !== 'boolean' ||
    typeof data.auth.admin !== 'boolean' ||
    (data.auth.signedIn && !data.auth.enabled) ||
    (data.auth.admin && !data.auth.signedIn) ||
    Boolean(data.dailyWordQuota.unlimited) !== expectedUnlimited ||
    data.dailyWordQuota.limit !== expectedLimit ||
    !Array.isArray(data.voices) || !data.voices.every(nonempty) || new Set(data.voices).size !== data.voices.length ||
    !Array.isArray(data.models) || !data.models.length || !data.models.every((model) => model &&
      nonempty(model.id) && model.id.length <= 200 && !/\s/.test(model.id) && nonempty(model.name) &&
       model.transport === 'live' && nonempty(model.role) && nonempty(model.description) &&
      positiveLimit(model.characterLimit) && typeof model.verified === 'boolean' &&
      typeof model.requiresLogin === 'boolean' && typeof model.requiresAdmin === 'boolean') ||
    new Set(data.models.map((model) => model.id)).size !== data.models.length) {
    throw new Error('The server returned an invalid streaming model catalog.');
  }
  for (const key of ['defaultModelId', 'modelId']) {
    if (data[key] != null && (!nonempty(data[key]) || !data.models.some((model) => model.id === data[key]))) {
      throw new Error('The server returned an invalid default model.');
    }
  }
  if (data.configured && (!data.voices.length || !(data.defaultModelId || data.modelId))) {
    throw new Error('The server returned an incomplete streaming configuration.');
  }
  return data;
}

function App() {
  const [text, setText] = useState('');
  const [expressionTags, setExpressionTags] = useState('Enthusiast, Excitement');
  const [config, setConfig] = useState(null);
  const [configStatus, setConfigStatus] = useState('loading');
  const [configError, setConfigError] = useState('');
  const [dailyWordQuota, setDailyWordQuota] = useState(null);
  const [chargedDraftWords, setChargedDraftWords] = useState(0);
  const [voice, setVoice] = useState('');
  const [modelId, setModelId] = useState('');
  const [status, setStatus] = useState('idle');
  const [audioUrl, setAudioUrl] = useState('');
  const [audioFormat, setAudioFormat] = useState('mp3');
  const [downloading, setDownloading] = useState(false);
  const [preparedExport, setPreparedExport] = useState(null);
  const [downloadError, setDownloadError] = useState('');
  const [authPrompt, setAuthPrompt] = useState(null);
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
  const resetRefreshRef = useRef('');
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
    setProgress({ completed: 0, total: 0 });
  }

  function changeSelection(key, value) {
    if (requestRef.current || selectionRef.current[key] === value) return;
    const model = config?.models.find((item) => item.id === value);
    if (key === 'modelId' && model?.requiresLogin && !config?.auth.signedIn) {
      setAuthPrompt('model');
      return;
    }
    if (key === 'modelId' && model?.requiresAdmin && !hasEnhancedAccess) {
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
      const userPlan = (data.user?.plan || 'free').toLowerCase();
      const hasEnhancedAccess = Boolean(data.auth.admin) || ['pro', 'studio'].includes(userPlan);
      const nextModelId = previousModel &&
        (!previousModel.requiresLogin || data.auth.signedIn) &&
        (!previousModel.requiresAdmin || hasEnhancedAccess)
        ? previous.modelId
        : data.defaultModelId || data.modelId || data.models[0].id;
      const nextVoice = data.voices.includes(previous.voice) ? previous.voice : data.voices.includes('Kore') ? 'Kore' : data.voices[0] || '';
      if (previous.modelId !== nextModelId || previous.voice !== nextVoice) resetOutput();
      selectionRef.current = { modelId: nextModelId, voice: nextVoice };
      setConfig(data); setModelId(nextModelId); setVoice(nextVoice);
      setDailyWordQuota(data.dailyWordQuota);
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
   const selectedModel = config?.models.find((model) => model.id === modelId);
   const modelPresentation = selectedModel ? getModelPresentation(selectedModel) : null;
   const limit = selectedModel?.characterLimit;
   const requestText = buildModulatedText(text, expressionTags);
   const count = requestText.length;
   const wordCount = requestText.match(/\S+/gu)?.length ?? 0;
   const draftWordsToCharge = Math.max(wordCount - chargedDraftWords, 0);
   const projectedDailyWords = dailyWordQuota ? dailyWordQuota.used + draftWordsToCharge : 0;
   const projectedWordsRemaining = dailyWordQuota ? Math.max(dailyWordQuota.remaining - draftWordsToCharge, 0) : 0;
  const overLimit = limit != null && count > limit;
   const overDailyLimit = dailyWordQuota != null && !dailyWordQuota.unlimited && wordCount > dailyWordQuota.remaining;
   const quotaExhausted = dailyWordQuota?.remaining === 0 && !dailyWordQuota?.unlimited;
   const signedInQuotaExhausted = Boolean(config?.auth.signedIn && quotaExhausted);
   const guestQuotaPromptNeeded = Boolean(!generating && config?.auth.signedIn === false && (quotaExhausted || overDailyLimit));
   const resetCountdown = dailyWordQuota?.resetsAt ? formatResetCountdown(dailyWordQuota.resetsAt, clockNow) : '00:00:00';
   const ready = configStatus === 'ready' && config?.configured && voice && selectedModel;
   const progressPercent = progress.total ? Math.round((progress.completed / progress.total) * 100) : 0;
  const percent = limit ? Math.min((count / limit) * 100, 100) : 0;
   const userPlan = (config?.user?.plan || 'free').toLowerCase();
   const isAdmin = Boolean(config?.auth?.admin);
   const isPaid = ['plus', 'pro', 'studio'].includes(userPlan);
   const hasEnhancedAccess = isAdmin || ['pro', 'studio'].includes(userPlan);
   const canSharePreparedExport = canShareFile(preparedExport?.file);
   const availability = getAvailability({
     configStatus,
     configured: config?.configured,
     voices: config?.voices,
     generating: busy,
     selectedModel,
     voice,
     text,
     overLimit,
     overDailyLimit,
     signedIn: config?.auth.signedIn,
     admin: config?.auth.admin,
     userPlan
   });

  useEffect(() => {
    if (!isFormatAllowed(audioFormat, userPlan, isAdmin)) {
      setAudioFormat('mp3');
    }
  }, [userPlan, isAdmin, audioFormat]);

  useEffect(() => {
    if (!guestQuotaPromptNeeded) return;
    setAuthPrompt('quota');
  }, [guestQuotaPromptNeeded]);

  useEffect(() => {
    if (!signedInQuotaExhausted || !dailyWordQuota?.resetsAt) return;
    const resetAt = Date.parse(dailyWordQuota.resetsAt);
    setClockNow(Date.now());
    const timer = setInterval(() => {
      const now = Date.now();
      setClockNow(now);
      if (now >= resetAt && resetRefreshRef.current !== dailyWordQuota.resetsAt) {
        resetRefreshRef.current = dailyWordQuota.resetsAt;
        void loadConfig();
      }
    }, 1000);
    return () => clearInterval(timer);
  }, [signedInQuotaExhausted, dailyWordQuota?.resetsAt]);

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
    if (!isFormatAllowed(format, userPlan, isAdmin)) {
      setAuthPrompt('formats');
      return;
    }
    setDownloadError('');
    clearPreparedExport();
    setAudioFormat(format);
  }

  async function downloadAudio() {
    if (downloadLockRef.current || !wavBytesRef.current) return;
    if (!isFormatAllowed(audioFormat, userPlan, isAdmin)) {
      setAuthPrompt('formats');
      return;
    }
    downloadLockRef.current = true;
    setDownloading(true);
    setDownloadError('');
    try {
      const formatKey = audioFormat;
      const { transcodeAudio } = await import('./audio-export.js');
      const bytes = await transcodeAudio(wavBytesRef.current, formatKey);
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
      setDownloadError(err instanceof Error ? err.message : 'Audio download could not be prepared.');
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
      setDownloadError(err instanceof Error ? err.message : 'The file could not be shared.');
    }
  }

  function cancel() {
    const controller = requestRef.current;
    requestRef.current = null;
    controller?.abort(); clearFile(); setStatus('cancelled'); setError('');
  }

  async function generate() {
    if (requestRef.current || downloadLockRef.current || !ready) return;
    setError('');
    if (!text.trim()) return setError('Add some text before generating audio.');
    if (overLimit) return setError(`Limit: ${limit.toLocaleString()} characters per request.`);
    if (overDailyLimit) return setError(`Only ${dailyWordQuota.remaining.toLocaleString()} daily words remain.`);
    clearFile();
    const controller = new AbortController();
    requestRef.current = controller;
    setStatus('generating'); setProgress({ completed: 0, total: 0 });
    let reader;
    const current = () => mountedRef.current && requestRef.current === controller && !controller.signal.aborted;
    try {
      const response = await fetch('/api/generate/stream', {
        method: 'POST',
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: requestText, model: modelId, voice })
      });
      if (!response.ok) {
        const data = await response.json();
        if (validDailyWordQuota(data.dailyWordQuota)) setDailyWordQuota(data.dailyWordQuota);
        throw new Error(data.error || 'Generation failed.');
      }
      if (!response.body) throw new Error('Streaming responses are not supported in this browser.');
      reader = response.body.getReader();
      const decoder = new TextDecoder('utf-8', { fatal: true });
      const chunks = [];
      let bytes = 0, wireBytes = 0, started = false, done = false, total = 0, completed = 0;
      const parser = createNDJSONParser((event) => {
        if (!current()) return;
        if (done) throw new Error('Received an event after stream completion.');
        if (event.type === 'error') throw new Error(typeof event.error === 'string' ? event.error : 'Generation failed.');
        if (event.type === 'start') {
          if (started || event.sampleRate !== SAMPLE_RATE || !Number.isInteger(event.totalChunks) || event.totalChunks <= 0 || !validDailyWordQuota(event.dailyWordQuota)) throw new Error('Invalid stream start.');
          setDailyWordQuota(event.dailyWordQuota);
          setChargedDraftWords(wordCount);
          started = true; total = event.totalChunks; setProgress({ completed: 0, total }); return;
        }
        if (!started) throw new Error('Audio stream did not begin with a start event.');
        if (event.type === 'audio') {
          const pcm = decodeBase64PCM(event.data);
          bytes += pcm.byteLength;
          if (bytes > MAX_AUDIO_BYTES) throw new Error('Audio exceeds the 128 MiB safety limit.');
          chunks.push(pcm);
        } else if (event.type === 'progress') {
          if (event.totalChunks !== total || !Number.isInteger(event.completedChunks) || event.completedChunks < completed || event.completedChunks > total) throw new Error('Invalid stream progress.');
          completed = event.completedChunks; setProgress({ completed, total });
        } else if (event.type === 'done') {
          if (completed !== total || !bytes) throw new Error('The audio stream is incomplete.');
          done = true;
        }
        else throw new Error('Unknown stream event.');
      });
      while (true) {
        const result = await reader.read();
        if (!current()) return;
        if (result.done) break;
        wireBytes += result.value.byteLength;
           if (wireBytes > MAX_STREAM_WIRE_BYTES) throw new Error('Stream exceeds the wire safety limit.');
        parser.push(decoder.decode(result.value, { stream: true }));
      }
      parser.push(decoder.decode()); parser.finish();
      if (!done) throw new Error('The audio stream ended before completion. Please retry.');
      const wav = encodeWav(chunks);
      if (!current()) return;
      wavBytesRef.current = wav;
      audioUrlRef.current = URL.createObjectURL(new Blob([wav], { type: 'audio/wav' }));
      setAudioUrl(audioUrlRef.current); setStatus('complete'); setProgress({ completed: total, total });
      chunks.length = 0;
    } catch (err) {
      if (!current()) return;
      controller.abort(); clearFile(); setError(err.message); setStatus('error');
    } finally {
      if (reader) { try { await reader.cancel(); } catch {} }
      if (requestRef.current === controller) requestRef.current = null;
    }
  }

  return <div className="app-shell">
     <header className="topbar"><div className="brand"><span className="brand-mark">◒</span><span>sonora</span><span className="badge">VOICE STUDIO</span></div><div className="topbar-right"><span>Text-to-speech workspace</span><a className="help-link" href="/pricing">{isPaid ? `Plan: ${userPlan.toUpperCase()}` : 'Upgrade'}</a><a className="help-link" href="/how-it-works">How it works &amp; FAQ</a>{config?.auth.signedIn
      ? <>{config.auth.admin && <span className="admin-pill">ADMIN</span>}{!config.auth.admin && isPaid && <span className="admin-pill" style={{ background: '#3b82f6', color: '#fff' }}>{userPlan.toUpperCase()}</span>}<button className="account-button" onClick={signOut}>Sign out</button></>
      : config?.auth.enabled
        ? <a className="account-button" href="/auth/google">Sign in with Google</a>
        : <button className="account-button" disabled title="Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and GOOGLE_REDIRECT_URI in Render to enable Google sign-in.">Sign in with Google</button>}</div>{authActionError && <p className="auth-error" role="alert">{authActionError}</p>}</header>
    <main className="workspace">
      <section className="hero" id="studio"><div><p className="eyebrow">SONORA · CREATIVE AUDIO</p><h1>AI text to speech<br /><em>with Sonora.</em></h1><p className="hero-copy">Turn your script into expressive voice narration. Choose a voice, guide its delivery with tags, preview the result, and export audio.</p></div><div className="hero-orb"><div className="orb-core" /><div className="wave wave-one" /><div className="wave wave-two" /><div className="wave wave-three" /></div></section>
      <section className="studio-grid">
         <div className="panel input-panel">
           <div className="panel-heading"><div><span className="step">01</span><h2>Write your script</h2></div><button className="sample-button" disabled={busy || signedInQuotaExhausted} onClick={() => { setText(SAMPLE); setChargedDraftWords(0); }}>Use sample <span>↗</span></button></div>
           <div className="expression-bar"><label className="expression-entry"><span className="expression-label">EMOTION & DELIVERY TAGS</span><input aria-label="Emotion and delivery tags" type="text" value={expressionTags} disabled={busy || signedInQuotaExhausted} onChange={(e) => { setExpressionTags(e.target.value); setChargedDraftWords(0); }} placeholder="e.g. Warm, excited, whispering" /><small>{buildModulatedText('', expressionTags).trim() || 'No tags added'}</small></label></div>
           <p className="expression-hint">Add tags separated by commas.</p>
           <div className={`textarea-wrap ${signedInQuotaExhausted ? 'quota-locked' : ''}`}><textarea aria-label="Script" aria-disabled={signedInQuotaExhausted} disabled={busy || signedInQuotaExhausted} onChange={(e) => { setText(e.target.value); setChargedDraftWords(0); }} value={text} placeholder="Write or paste your script…" />{signedInQuotaExhausted && <div className="quota-lock-message" role="status"><strong>Daily allowance used</strong><span>Next reset in</span><time>{resetCountdown}</time></div>}<div className="textarea-footer"><span className={overLimit ? 'counter over' : 'counter'}>{count.toLocaleString()} <span>/ {limit ? limit.toLocaleString() : '—'} characters</span></span><span className="word-counter" aria-label={`${wordCount.toLocaleString()} words in draft, including tags`}>{wordCount.toLocaleString()} words <span>incl. tags</span></span><span className="tag-hint">Tags included</span></div></div>
           <div className="quota-track"><div style={{ width: `${percent}%` }} /></div>
           <p className={overDailyLimit ? 'daily-quota over' : 'daily-quota'}>{dailyWordQuota?.unlimited ? (isAdmin ? 'Admin access · daily word cap bypassed' : 'Daily word cap bypassed') : dailyWordQuota ? `${projectedDailyWords.toLocaleString()} / ${dailyWordQuota.limit.toLocaleString()} words incl. draft · ${projectedWordsRemaining.toLocaleString()} left · resets 00:00 UTC` : 'Loading daily allowance…'}</p>
           <p className="quota-disclaimer">{dailyWordQuota?.unlimited ? 'Per-request and provider safety limits still apply.' : config?.auth.signedIn ? `${userPlan === 'studio' ? 'Studio plan' : userPlan === 'pro' ? 'Pro plan' : userPlan === 'plus' ? 'Plus plan' : 'Google account'} allowance · ${dailyWordQuota?.limit.toLocaleString()} words each UTC day.` : 'Guest allowance · 50 words each UTC day.'}</p>
           {overLimit && <p className="error-text">Character limit reached. Shorten your script.</p>}{overDailyLimit && <p className="error-text">Daily word limit reached. Shorten your script or wait for reset.</p>}
         </div>
        <aside className="panel settings-panel">
          <div className="panel-heading"><div><span className="step">02</span><h2>Voice settings</h2></div><span className="live-pill">STUDIO</span></div>
           <label>ENGINE<select value={selectedModel ? modelId : ''} disabled={busy || configStatus !== 'ready'} onChange={(e) => changeSelection('modelId', e.target.value)} aria-describedby="engine-description">
             {!selectedModel && <option value="">{configStatus === 'loading' ? 'Loading engines…' : 'No engines available'}</option>}
             {(config?.models || []).filter((model) =>
               (!model.requiresLogin || config?.auth.signedIn) &&
               (!model.requiresAdmin || hasEnhancedAccess)
             ).map((model) => <option key={model.id} value={model.id}>{getModelPresentation(model).name}</option>)}
           </select></label>
           {selectedModel && modelPresentation && <div className="engine-description" id="engine-description">
             <div className="model-profile"><strong>{modelPresentation.profile}</strong><span>{selectedModel.characterLimit.toLocaleString()} character app limit</span></div>
             {selectedModel.requiresLogin && !config?.auth.signedIn && <p className="model-access-note">Sign in with Google to use the Balanced model.</p>}
             {selectedModel.requiresAdmin && !hasEnhancedAccess && <p className="model-access-note">Enhanced Thinking requires a Pro, Studio, or Admin plan.</p>}
           </div>}
           <p className="model-note">AI may not produce the exact output you expect.</p>
          <div className="config-status" role="status"><p>{configStatus === 'loading' ? 'Checking server configuration…' : configError || (config?.configured ? 'Server configured · Streaming available' : 'Server is not configured. Set up the server, then retry.')}</p><button className="sample-button" disabled={busy || configStatus === 'loading'} onClick={loadConfig}>Retry configuration ↗</button></div>
          <label>VOICE<select value={voice} disabled={availability.voiceDisabled} onChange={(e) => changeSelection('voice', e.target.value)}>{!voice && <option value="">No voices available</option>}{(config?.voices || []).map((item) => <option key={item} value={item}>{VOICE_LABELS[item] || 'Studio voice'}</option>)}</select></label>
          <div className="voice-preview"><div className="avatar">{VOICE_LABELS[voice]?.slice(0, 1) || '—'}</div><div><strong>{VOICE_LABELS[voice] || 'Choose a voice'}</strong><small>Studio voice</small></div><div className="mini-wave">▁▃▆▃▅▂▃</div></div>
          <button className="generate-button" disabled={availability.generateDisabled} aria-describedby="generation-requirements" onClick={generate}>{generating ? <><span className="spinner" /> Synthesizing…</> : <>Generate audio <span>→</span></>}</button>
          <p id="generation-requirements" className="engine-description" role="status">{availability.reason || 'Ready.'}</p>
          {error && <p className="error-text" role="alert">{error}</p>}
        </aside>
      </section>
      <section className={`output-panel ${audioUrl ? 'has-audio' : ''} ${generating ? 'is-generating' : ''}`}>
        <div className="output-label"><span className="step">03</span><div><h2>{audioUrl ? 'Preview your narration' : 'Audio output'}</h2><p role="status">{generating ? `Generating audio · ${progress.completed} of ${progress.total || '…'} segments complete` : audioUrl ? 'Preview the audio below, choose a format, and download.' : status === 'cancelled' ? 'Generation cancelled · No partial file saved' : status === 'error' ? 'Generation failed · No partial file saved' : 'Your completed audio will be available here.'}</p></div></div>
        {generating && <div className="generation-progress"><div className="progress-caption"><span>Generation progress</span><strong>{progressPercent}%</strong></div><progress aria-label="Generation progress" value={progressPercent} max="100" /></div>}
        <div className="output-controls">{generating && <button className="cancel-button" onClick={cancel}>Cancel generation</button>}{audioUrl && <><audio controls preload="metadata" src={audioUrl} aria-label="Preview completed narration" /><label className="format-picker">DOWNLOAD FORMAT<select aria-label="Download format" value={audioFormat} disabled={downloading || configStatus !== 'ready'} onChange={(event) => selectAudioFormat(event.target.value)}>{Object.entries(AUDIO_FORMATS).map(([format, details]) => { const allowed = isFormatAllowed(format, userPlan, isAdmin); const minPlan = FORMAT_MIN_PLAN[format] || 'Free'; const tag = !allowed ? ` · ${minPlan}${minPlan === 'Studio' ? '' : '+'}` : ''; return <option key={format} value={format}>{details.label}{tag}</option>; })}</select></label>{preparedExport?.format === audioFormat ? <><a className="download-button" href={preparedExport.url} download={preparedExport.filename}>Save {AUDIO_FORMATS[audioFormat].label} file ↓</a>{canSharePreparedExport && <button className="download-button" onClick={sharePreparedExport}>Share / Save file ↗</button>}</> : <button className="download-button" disabled={downloading} onClick={downloadAudio}>{downloading ? 'Preparing…' : `Prepare ${AUDIO_FORMATS[audioFormat].label} ↓`}</button>}</>}</div>
        {preparedExport?.format === audioFormat && <p className="format-note" role="status">Your {AUDIO_FORMATS[audioFormat].label} is ready. Tap Save file, or use Share / Save on supported phones.</p>}
        {audioUrl && !preparedExport && <p className="format-note">First export loads the audio encoder (~32 MB). Conversion runs in your browser; audio stays on your device. On phones, tap Prepare, then Save file or Share / Save.</p>}
        {audioUrl && !isAdmin && userPlan !== 'studio' && <p className="format-note">Plus adds AAC &amp; OGG, Pro adds FLAC, and Studio includes Master WAV. <a href="/pricing">See plans</a>.</p>}
        {downloadError && <p className="error-text download-error" role="alert">{downloadError}</p>}
        {!audioUrl && !generating && <div className="empty-wave">{[...Array(32)].map((_, i) => <i key={i} style={{ height: `${10 + (i * 17) % 38}px` }} />)}</div>}
      </section>
    </main>
    {authPrompt && <div className="auth-modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setAuthPrompt(null); }}><section className="auth-modal" role="dialog" aria-modal="true" aria-labelledby="auth-modal-title"><button className="modal-close" aria-label="Close dialog" onClick={() => setAuthPrompt(null)}>×</button><span className="modal-eyebrow">{authPrompt === 'quota' ? 'DAILY ALLOWANCE' : authPrompt === 'model' ? 'MODEL ACCESS' : 'MORE AUDIO FORMATS'}</span><h2 id="auth-modal-title">{authPrompt === 'quota' ? 'Keep creating with Google' : authPrompt === 'model' ? (config?.auth.signedIn ? 'Enhanced Thinking is admin-only for now' : 'Sign in to use Balanced') : 'Unlock premium formats'}</h2><p>{authPrompt === 'quota' ? (quotaExhausted ? 'Your guest word allowance is used up. Sign in for a separate 1,000-word daily allowance.' : 'This script is over your remaining guest words. Sign in for a separate 1,000-word daily allowance.') : authPrompt === 'model' ? (config?.auth.signedIn ? 'Enhanced Thinking requires Pro or Studio plan.' : 'The Balanced model is available after you sign in with Google. Guests can use Low Quality.') : 'Free includes MP3 only. Plus adds AAC and OGG, Pro adds FLAC, and Studio includes uncompressed Studio Master WAV.'}</p>{authPrompt === 'formats' || config?.auth.signedIn ? <a className="account-button modal-sign-in" href="/pricing">View plans</a> : config?.auth.enabled ? <a className="account-button modal-sign-in" href="/auth/google" target="_blank" rel="noreferrer" onClick={() => { authPopupRequestedRef.current = true; }}>Sign in with Google</a> : <button className="account-button modal-sign-in" disabled title="Google sign-in is not configured on this server.">Google sign-in unavailable</button>}<button className="modal-dismiss" onClick={() => setAuthPrompt(null)}>Continue as guest</button></section></div>}
  </div>;
}
createRoot(document.getElementById('root')).render(<App />);
