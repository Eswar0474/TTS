import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import './stream.css';
import { getAvailability } from './availability.js';
import { countRequestWords, getRequestWordLimit, validateConfig } from './config.js';
import { buildModulatedText } from './expression.js';
import { getModelPresentation, VOICE_LABELS } from './presentation.js';
import { AUDIO_FORMATS, isFormatAllowed } from './audio-formats.js';
import { errorMessage } from './export-errors.js';
import { estimateGenerationSeconds, formatApproximateDuration, formatElapsedTime, getRequestTiming } from './timing.js';
import AuthModal from './components/AuthModal';
import HistoryModal from './components/HistoryModal';


const API_BASE_URL = (import.meta.env.VITE_BACKEND_URL || '').replace(/\/+$/, '');
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
  
  // Custom Auth State
  const [showAuthModal, setShowAuthModal] = useState(false);
  const [authPromptReason, setAuthPromptReason] = useState('');
  const [user, setUser] = useState(null);
  const [showHistoryModal, setShowHistoryModal] = useState(false);

  // Queue State
  const [queueInfo, setQueueInfo] = useState({ active: false, position: 0, estimatedMinutes: 0, processing: false });

  const [requestTiming, setRequestTiming] = useState(null);
  const [clockNow, setClockNow] = useState(Date.now());
  const [error, setError] = useState('');
  
  const requestRef = useRef(null);
  const configRequestRef = useRef(null);
  const audioUrlRef = useRef('');
  const preparedExportRef = useRef(null);
  const wavBytesRef = useRef(null);
  const downloadLockRef = useRef(false);
  const pollIntervalRef = useRef(null);
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
    setRequestTiming(null); setQueueInfo({ active: false });
    if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
  }

  function triggerAuthPrompt(reason) {
    setAuthPromptReason(reason);
    setShowAuthModal(true);
  }

  function handleLoginSuccess(userData) {
    setUser(userData);
    setShowAuthModal(false);
    loadConfig(); 
  }

  function signOut() {
    localStorage.removeItem('sonora_token');
    setUser(null);
    setAudioFormat('mp3');
    clearPreparedExport();
    loadConfig();
  }

  function changeSelection(key, value) {
    if (requestRef.current || selectionRef.current[key] === value) return;
    const model = config?.models.find((item) => item.id === value);
    if (key === 'modelId' && model?.requiresLogin && !user) {
      triggerAuthPrompt('model');
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
      const response = await fetch(`${API_BASE_URL}/api/config`, { signal: controller.signal });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Unable to load server configuration.');
      validateConfig(data);
      if (controller.signal.aborted || !mountedRef.current || configRequestRef.current !== controller) return;
      const previous = selectionRef.current;
      const previousModel = data.models.find((model) => model.id === previous.modelId);
      const nextModelId = previousModel && (!previousModel.requiresLogin || user)
        ? previous.modelId
        : data.defaultModelId || data.modelId || data.models[0].id;
      const nextVoice = data.voices.includes(previous.voice) ? previous.voice : data.voices.includes('Kore') ? 'Kore' : data.voices[0] || '';
      
      if (previous.modelId !== nextModelId || previous.voice !== nextVoice) resetOutput();
      selectionRef.current = { modelId: nextModelId, voice: nextVoice };
      setConfig(data); setModelId(nextModelId); setVoice(nextVoice);
      setConfigStatus('ready');
    } catch (err) {
      if (controller.signal.aborted || !mountedRef.current || configRequestRef.current !== controller) return;
      setConfig(null); setConfigStatus('error'); setConfigError(err.message);
    }
  }

  useEffect(() => {
    mountedRef.current = true;
    const token = localStorage.getItem('sonora_token');
    if (token) setUser({ name: "User", email: "user@sonora.app" }); 
    void loadConfig();
    return () => {
      mountedRef.current = false;
      requestRef.current?.abort(); configRequestRef.current?.abort();
      if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
      if (audioUrlRef.current) URL.revokeObjectURL(audioUrlRef.current);
      if (preparedExportRef.current?.url) URL.revokeObjectURL(preparedExportRef.current.url);
    };
  }, []);

  const generating = status === 'generating';
  const busy = generating || downloading;
  const signedIn = Boolean(user);
  const verifiedAdmin = false; 
  const selectedModel = config?.models.find((model) => model.id === modelId);
  const modelPresentation = selectedModel ? getModelPresentation(selectedModel) : null;
  const characterLimit = selectedModel?.characterLimit;
  const wordLimit = getRequestWordLimit(selectedModel, { signedIn }, config?.guestWordLimit);
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
  const canSharePreparedExport = canShareFile(preparedExport?.file);
  
  const availability = getAvailability({
    configStatus, configured: config?.configured, voices: config?.voices,
    generating: busy, selectedModel, voice, text, overWordLimit, overCharacterLimit, signedIn, wordLimit
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

  function selectAudioFormat(format) {
    if (!Object.hasOwn(AUDIO_FORMATS, format)) return;
    if (!isFormatAllowed(format, signedIn)) {
      triggerAuthPrompt('formats');
      return;
    }
    setDownloadError('');
    clearPreparedExport();
    setAudioFormat(format);
  }

  async function downloadAudio() {
    if (downloadLockRef.current || !wavBytesRef.current) return;
    if (!isFormatAllowed(audioFormat, signedIn)) {
      triggerAuthPrompt('formats');
      return;
    }
    downloadLockRef.current = true;
    setDownloading(true);
    setDownloadError('');
    try {
      const formatKey = audioFormat;
      const sourceWav = wavBytesRef.current;
      const bytes = formatKey === 'wav'
        ? sourceWav
        : await (await import('./audio-export.js')).transcodeAudio(sourceWav, formatKey);
      
      const format = AUDIO_FORMATS[formatKey];
      const filename = `sonora-speech.${format.extension}`;
      const blob = new Blob([bytes], { type: format.mimeType });
      const file = typeof File === 'function' ? new File([blob], filename, { type: format.mimeType }) : null;
      const nextExport = { url: URL.createObjectURL(blob), filename, format: formatKey, file };
      
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
    if (!file || !canShareFile(file)) {
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
    if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
    setRequestTiming((previous) => previous && !previous.finishedAt ? { ...previous, finishedAt: Date.now() } : previous);
    controller?.abort(); clearFile(); setStatus('cancelled'); setError(''); setQueueInfo({ active: false });
  }

  async function generate() {
    if (requestRef.current || downloadLockRef.current || !ready) return;
    setError('');
    if (!text.trim()) return setError('Add some text before generating audio.');
    if (selectedModel.requiresLogin && !signedIn) { triggerAuthPrompt('model'); return; }
    if (hasWordLimit && overWordLimit) return setError(`Limit: ${formattedWordLimit} words per request, including tags.`);
    if (overCharacterLimit) return setError(`Limit: ${characterLimit.toLocaleString()} characters per request.`);
    
    clearFile();
    const controller = new AbortController();
    requestRef.current = controller;
    const startedAt = Date.now();
    setClockNow(startedAt);
    setRequestTiming({ startedAt, finishedAt: null, estimateSeconds: estimatedSeconds });
    setStatus('generating');
    setQueueInfo({ active: true, position: 0, estimatedMinutes: 0, processing: false });

    try {
      const token = localStorage.getItem('sonora_token');
      const email = user ? user.email : null;
      
      const res = await fetch(`${API_BASE_URL}/api/generate/enqueue`, {
        method: 'POST',
        signal: controller.signal,
        headers: { 
            'Content-Type': 'application/json',
            ...(token ? { 'Authorization': `Bearer ${token}` } : {})
        },
        body: JSON.stringify({ text: requestText, model: modelId, voice, email })
      });
      
      if (!res.ok) throw new Error("Failed to join generation queue.");
      const { job_id } = await res.json();
      
      // Poll Queue Status
      pollIntervalRef.current = setInterval(async () => {
          if (!requestRef.current) {
              clearInterval(pollIntervalRef.current);
              return;
          }
          
          const statusRes = await fetch(`${API_BASE_URL}/api/generate/status/${job_id}`);
          const data = await statusRes.json();
          
          if (data.status === 'pending') {
              setQueueInfo({ active: true, position: data.position, estimatedMinutes: data.estimated_minutes, processing: false });
          } 
          else if (data.status === 'processing') {
              setQueueInfo({ active: true, position: 0, estimatedMinutes: 0, processing: true });
          }
          else if (data.status === 'completed') {
              clearInterval(pollIntervalRef.current);
              if (!requestRef.current) return;

              // Fetch the bytes from the bucket URL to allow local format conversion
              const audioRes = await fetch(data.download_url);
              const arrayBuf = await audioRes.arrayBuffer();
              const wavBytes = new Uint8Array(arrayBuf);
              
              wavBytesRef.current = wavBytes;
              audioUrlRef.current = URL.createObjectURL(new Blob([wavBytes], { type: 'audio/wav' }));
              
              setQueueInfo({ active: false });
              setRequestTiming(prev => prev ? { ...prev, finishedAt: Date.now() } : prev);
              setAudioUrl(audioUrlRef.current); 
              setStatus('complete');
              requestRef.current = null;
          }
          else if (data.status === 'failed') {
              clearInterval(pollIntervalRef.current);
              setQueueInfo({ active: false });
              setStatus('error');
              setError(data.error_message || "Generation failed. Please try again.");
              requestRef.current = null;
          }
      }, 5000); 

    } catch (err) {
      if (controller.signal.aborted) return;
      setStatus('error');
      setError(err.message);
      setQueueInfo({ active: false });
      requestRef.current = null;
    }
  }

  return <div className="app-shell">
      <header className="topbar">
          <div className="brand"><span className="brand-mark">◒</span><span>sonora</span><span className="badge">VOICE STUDIO</span></div>
          <div className="topbar-right">
              <span>Text-to-speech workspace</span>
              <a className="help-link" href="/how-it-works">How it works &amp; FAQ</a>
              {signedIn ? (
                <>
                  <button className="account-button" onClick={() => setShowHistoryModal(true)}>History</button>
                  <button className="account-button" disabled={busy} onClick={signOut}>Sign out</button>
                </>
                ) : (
                  <button className="account-button" onClick={() => triggerAuthPrompt('model')}>Sign In / Register</button>
              )}
          </div>
      </header>
      
    <main className="workspace">
      <section className="hero" id="studio"><div><p className="eyebrow">SONORA · CREATIVE AUDIO</p><h1>AI text to speech<br /><em>with Sonora.</em></h1><p className="hero-copy">Turn your script into expressive voice narration. Choose a voice, guide its delivery with tags, preview the result, and export audio.</p></div><div className="hero-orb"><div className="orb-core" /><div className="wave wave-one" /><div className="wave wave-two" /><div className="wave wave-three" /></div></section>
      
      <section className="studio-grid">
         <div className="panel input-panel">
            <div className="panel-heading"><div><span className="step">01</span><h2>Write your script</h2></div><button className="sample-button" disabled={busy} onClick={() => setText(SAMPLE)}>Use sample <span>↗</span></button></div>
            <div className="expression-bar"><label className="expression-entry"><span className="expression-label">EMOTION & DELIVERY TAGS</span><input aria-label="Emotion and delivery tags" type="text" value={expressionTags} disabled={busy} onChange={(e) => setExpressionTags(e.target.value)} placeholder="e.g. Warm, excited, whispering" /><small>{buildModulatedText('', expressionTags).trim() || 'No tags added'}</small></label></div>
            <p className="expression-hint">Add tags separated by commas.</p>
             <div className="textarea-wrap"><textarea aria-label="Script" disabled={busy} onChange={(e) => setText(e.target.value)} value={text} placeholder="Write or paste your script…" /><div className="textarea-footer"><span className={verifiedAdmin && selectedModel ? 'word-counter admin' : overWordLimit ? 'word-counter over' : 'word-counter'}>{verifiedAdmin && selectedModel ? <>{wordCount.toLocaleString()} words · Admin · no word limit <span>per request · incl. tags</span></> : <>{wordCount.toLocaleString()} / {formattedWordLimit} words <span>per request · incl. tags</span></>}</span><span className={overCharacterLimit ? 'counter over' : 'counter'}>{characterCount.toLocaleString()} <span>/ {characterLimit?.toLocaleString() || '—'} characters</span></span></div></div>
              {hasWordLimit && <div className="request-limit-track" aria-hidden="true"><div style={{ width: `${percent}%` }} /></div>}
              <p className="request-guidance">{verifiedAdmin && selectedModel ? 'No daily quota. Admin word-limit exemption applies to each request; character and audio safety limits still apply.' : 'No daily quota. The word limit applies to each request separately.'}</p>
            {!signedIn && configStatus === 'ready' && <p className="request-guidance">Guests can use Low Quality with up to {config?.guestWordLimit.toLocaleString()} words per request. <button className="inline-sign-in" onClick={() => triggerAuthPrompt('model')}>Sign in for Balanced, Enhanced Thinking, and higher limits</button>.</p>}
             {hasWordLimit && overWordLimit && <p className="error-text" role="status">{signedIn ? `This engine allows ${formattedWordLimit} words per request, including tags. Shorten your script.` : `The guest limit is ${formattedWordLimit} words per request, including tags. Shorten your script or sign in.`}</p>}
            {overCharacterLimit && <p className="error-text" role="status">Character safety limit reached. Shorten your script to {characterLimit.toLocaleString()} characters.</p>}
         </div>
        
        <aside className="panel settings-panel">
          <div className="panel-heading">
              <div><span className="step">02</span><h2>Voice settings</h2></div>
              <span className="live-pill">STUDIO</span>
          </div>
          
           <label>ENGINE
               <select value={selectedModel ? modelId : ''} disabled={busy || configStatus !== 'ready'} onChange={(e) => changeSelection('modelId', e.target.value)} aria-describedby="engine-description">
                 {!selectedModel && <option value="">{configStatus === 'loading' ? 'Loading engines…' : 'No engines available'}</option>}
                  {(config?.models || []).map((model) => <option key={model.id} value={model.id}>{getModelPresentation(model).name}{model.requiresLogin && !signedIn ? ' · Sign in' : ''}</option>)}
                </select>
            </label>
            
            {selectedModel && modelPresentation && (
                <div className="engine-description" id="engine-description">
                   <div className="model-profile">
                       <strong>{modelPresentation.profile}</strong>
                       <span>{verifiedAdmin ? 'Admin · no word limit' : hasWordLimit ? `${formattedWordLimit} words per request` : 'Word limit unavailable'} · {selectedModel.characterLimit.toLocaleString()} character safety cap</span>
                   </div>
                </div>
            )}
            
           <p className="model-note">AI may not produce the exact output you expect.</p>
           
          <div className="config-status" role="status">
              <p>{configStatus === 'loading' ? 'Checking server configuration…' : configError || (config?.configured ? 'Server configured · Streaming available' : 'Server is not configured. Set up the server, then retry.')}</p>
              <button className="sample-button" disabled={busy || configStatus === 'loading'} onClick={loadConfig}>Retry configuration ↗</button>
          </div>
          
           <label>VOICE
               <select value={voice} disabled={availability.voiceDisabled} onChange={(e) => changeSelection('voice', e.target.value)}>
                   {!voice && <option value="">No voices available</option>}
                   {(config?.voices || []).map((item) => <option key={item} value={item}>{VOICE_LABELS[item] || 'Studio voice'}</option>)}
                </select>
            </label>
            
           <div className="voice-preview">
               <div className="avatar">{VOICE_LABELS[voice]?.slice(0, 1) || '—'}</div>
               <div>
                   <strong>{VOICE_LABELS[voice] || 'Choose a voice'}</strong>
                   <small>Studio voice</small>
               </div>
               <div className="mini-wave">▁▃▆▃▅▂▃</div>
           </div>
           
           <p className="estimate-note" role="status">
               {text.trim() ? (
                   <>Approx. generation time: <strong>{formatApproximateDuration(generating && requestTiming ? requestTiming.estimateSeconds : estimatedSeconds)}</strong><span>Estimate only; synthesis may take longer.</span></>
               ) : (
                   'Add a script to see an approximate generation time.'
               )}
           </p>
           
           {/* THIS IS THE EXACT GENERATION BUTTON SECTION */}
           <button className="generate-button" disabled={availability.generateDisabled} aria-describedby="generation-requirements" onClick={generate}>
               {generating ? (
                   <><span className="spinner" /> Enqueuing…</>
               ) : (
                   <>Generate audio <span>→</span></>
               )}
           </button>
           
          <p id="generation-requirements" className="engine-description" role="status">
              {availability.reason || 'Ready.'}
          </p>
          
          {error && <p className="error-text" role="alert">{error}</p>}
        </aside>
      </section>

      <section className={`output-panel ${audioUrl ? 'has-audio' : ''} ${generating ? 'is-generating' : ''}`}>
        <div className="output-label"><span className="step">03</span><div><h2>{audioUrl ? 'Preview your narration' : 'Audio output'}</h2>
           <p role="status">{generating ? `Processing request...` : audioUrl ? 'Preview the audio below, choose a format, and download.' : status === 'cancelled' ? 'Generation cancelled' : status === 'error' ? 'Generation failed' : 'Your completed audio will be available here.'}</p></div></div>
         
         {timing && <p className="elapsed-note" role="timer">{generating ? <>Elapsed: {formatElapsedTime(timing.elapsedSeconds)} · {timing.takingLonger ? 'Taking longer than the approximate estimate…' : `Approx. request estimate: ${formatApproximateDuration(requestTiming.estimateSeconds)}`}</> : status === 'complete' ? `Completed in ${formatElapsedTime(timing.elapsedSeconds)}` : status === 'cancelled' ? `Cancelled after ${formatElapsedTime(timing.elapsedSeconds)}` : `Stopped after ${formatElapsedTime(timing.elapsedSeconds)}`}</p>}
         
         {/* Queue Progress Bar */}
         {generating && queueInfo.active && <div className="generation-progress">
             <div className="progress-caption"><span>{queueInfo.processing ? "Generating audio..." : "Queue Position"}</span><strong>{queueInfo.processing ? "Active" : queueInfo.position}</strong></div>
             {!queueInfo.processing && <p style={{color: '#87827b', fontSize: '11px', margin: '5px 0 0'}}>Est. wait: {queueInfo.estimatedMinutes} min. {user ? "We'll email you a link if you leave." : "Guests must stay on this page."}</p>}
         </div>}
         
         <div className="output-controls">
             {generating && <button className="cancel-button" onClick={cancel}>Cancel Request</button>}
             {audioUrl && <>
                <audio controls preload="metadata" src={audioUrl} aria-label="Preview completed narration" />
                <label className="format-picker">DOWNLOAD FORMAT<select aria-label="Download format" value={audioFormat} disabled={downloading || configStatus !== 'ready'} onChange={(event) => selectAudioFormat(event.target.value)}>{Object.entries(AUDIO_FORMATS).map(([format, details]) => <option key={format} value={format}>{details.label}{isFormatAllowed(format, signedIn) ? '' : ' · Sign in'}</option>)}</select></label>
                {preparedExport?.format === audioFormat ? <><a className="download-button" href={preparedExport.url} download={preparedExport.filename}>Save {AUDIO_FORMATS[audioFormat].label} file ↓</a>{canSharePreparedExport && <button className="download-button" onClick={sharePreparedExport}>Share / Save file ↗</button>}</> : <button className="download-button" disabled={downloading} onClick={downloadAudio}>{downloading ? 'Preparing…' : `Prepare ${AUDIO_FORMATS[audioFormat].label} ↓`}</button>}
             </>}
        </div>
        
        {preparedExport?.format === audioFormat && <p className="format-note" role="status">Your {AUDIO_FORMATS[audioFormat].label} is ready. Tap Save file, or use Share / Save on supported phones.</p>}
        {audioUrl && !preparedExport && <p className="format-note">{audioFormat === 'wav' ? 'WAV is ready without conversion.' : 'First conversion loads the audio encoder (~32 MB). Conversion runs in your browser; audio stays on your device.'} On phones, tap Prepare, then Save file or Share / Save.</p>}
        {downloadError && <p className="error-text download-error" role="alert">{downloadError}</p>}
        {!audioUrl && !generating && <div className="empty-wave">{[...Array(32)].map((_, i) => <i key={i} style={{ height: `${10 + (i * 17) % 38}px` }} />)}</div>}
      </section>
    </main>
    
    {showAuthModal && (
        <AuthModal 
            onClose={() => setShowAuthModal(false)}
            onLoginSuccess={handleLoginSuccess}
            reason={authPromptReason}
        />
    )}
    {showHistoryModal && (
    <HistoryModal onClose={() => setShowHistoryModal(false)} />
    )}
  </div>;
}

createRoot(document.getElementById('root')).render(<App />);