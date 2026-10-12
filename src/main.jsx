import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { SAMPLE_RATE, MAX_AUDIO_BYTES, decodeBase64PCM, encodeWav, createNDJSONParser } from './audio.js';
import './styles.css';
import './stream.css';
import { getAvailability } from './availability.js';
import { buildModulatedText } from './expression.js';
import { getModelPresentation, VOICE_LABELS } from './presentation.js';

const SAMPLE = 'The future is not a destination. It is a rhythm we learn to move with.';
const DAILY_WORD_LIMIT = 1000;
const validDailyWordQuota = (quota) => quota && quota.limit === DAILY_WORD_LIMIT &&
  Number.isSafeInteger(quota.used) && quota.used >= 0 && quota.used <= DAILY_WORD_LIMIT &&
  quota.remaining === DAILY_WORD_LIMIT - quota.used &&
  typeof quota.resetsAt === 'string' && Number.isFinite(Date.parse(quota.resetsAt));

function validateConfig(data) {
  const nonempty = (value) => typeof value === 'string' && value.trim().length > 0;
  const positiveLimit = (value) => Number.isSafeInteger(value) && value > 0;
  if (!data || typeof data.configured !== 'boolean' || !positiveLimit(data.characterLimit) || data.streaming !== true ||
    !validDailyWordQuota(data.dailyWordQuota) ||
    !Array.isArray(data.voices) || !data.voices.every(nonempty) || new Set(data.voices).size !== data.voices.length ||
    !Array.isArray(data.models) || !data.models.length || !data.models.every((model) => model &&
      nonempty(model.id) && model.id.length <= 200 && !/\s/.test(model.id) && nonempty(model.name) &&
       model.transport === 'live' && nonempty(model.role) && nonempty(model.description) &&
      positiveLimit(model.characterLimit) && typeof model.verified === 'boolean') ||
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
  const [voice, setVoice] = useState('');
  const [modelId, setModelId] = useState('');
  const [status, setStatus] = useState('idle');
  const [audioUrl, setAudioUrl] = useState('');
  const [error, setError] = useState('');
  const [progress, setProgress] = useState({ completed: 0, total: 0 });
  const requestRef = useRef(null);
  const configRequestRef = useRef(null);
  const audioUrlRef = useRef('');
  const mountedRef = useRef(true);
  const selectionRef = useRef({ modelId: '', voice: '' });

  function clearFile() {
    if (audioUrlRef.current) URL.revokeObjectURL(audioUrlRef.current);
    audioUrlRef.current = '';
    setAudioUrl('');
  }

  function resetOutput() {
    clearFile(); setStatus('idle'); setError('');
    setProgress({ completed: 0, total: 0 });
  }

  function changeSelection(key, value) {
    if (requestRef.current || selectionRef.current[key] === value) return;
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
      const nextModelId = data.models.some((model) => model.id === previous.modelId) ? previous.modelId : data.defaultModelId || data.modelId || data.models[0].id;
      const nextVoice = data.voices.includes(previous.voice) ? previous.voice : data.voices.includes('Kore') ? 'Kore' : data.voices[0] || '';
      if (previous.modelId !== nextModelId || previous.voice !== nextVoice) resetOutput();
      selectionRef.current = { modelId: nextModelId, voice: nextVoice };
      setConfig(data); setModelId(nextModelId); setVoice(nextVoice);
      setDailyWordQuota(data.dailyWordQuota);
      setConfigStatus('ready');
    } catch (err) {
      if (controller.signal.aborted || !mountedRef.current || configRequestRef.current !== controller) return;
      setConfig(null); setConfigStatus('error'); setConfigError(err.message);
    }
  }

  useEffect(() => {
    mountedRef.current = true;
    void loadConfig();
    return () => {
      mountedRef.current = false;
      requestRef.current?.abort(); configRequestRef.current?.abort();
      if (audioUrlRef.current) URL.revokeObjectURL(audioUrlRef.current);
    };
  }, []);

  const generating = status === 'generating';
   const selectedModel = config?.models.find((model) => model.id === modelId);
   const modelPresentation = selectedModel ? getModelPresentation(selectedModel) : null;
   const limit = selectedModel?.characterLimit;
   const requestText = buildModulatedText(text, expressionTags);
   const count = requestText.length;
   const wordCount = requestText.match(/\S+/gu)?.length ?? 0;
  const overLimit = limit != null && count > limit;
   const overDailyLimit = dailyWordQuota != null && wordCount > dailyWordQuota.remaining;
   const quotaExhausted = dailyWordQuota?.remaining === 0;
   const ready = configStatus === 'ready' && config?.configured && voice && selectedModel;
   const progressPercent = progress.total ? Math.round((progress.completed / progress.total) * 100) : 0;
  const percent = limit ? Math.min((count / limit) * 100, 100) : 0;
   const availability = getAvailability({ configStatus, configured: config?.configured, voices: config?.voices, generating, selectedModel, voice, text, overLimit, overDailyLimit });

  function cancel() {
    const controller = requestRef.current;
    requestRef.current = null;
    controller?.abort(); clearFile(); setStatus('cancelled'); setError('');
  }

  async function generate() {
    if (requestRef.current || !ready) return;
    setError('');
     if (!text.trim()) return setError('Add some text before generating audio.');
    if (overLimit) return setError(`Text exceeds the application cap of ${limit.toLocaleString()} characters.`);
    if (overDailyLimit) return setError(`This request needs ${wordCount.toLocaleString()} words, but only ${dailyWordQuota.remaining.toLocaleString()} remain in today's shared-IP allowance.`);
    clearFile();
    const controller = new AbortController();
    requestRef.current = controller;
    setStatus('generating'); setProgress({ completed: 0, total: 0 });
    let reader;
    const current = () => mountedRef.current && requestRef.current === controller && !controller.signal.aborted;
    try {
      const response = await fetch('/api/generate/stream', { method: 'POST', signal: controller.signal, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: requestText, model: modelId, voice }) });
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
        if (wireBytes > MAX_AUDIO_BYTES) throw new Error('Stream exceeds the 128 MiB safety limit.');
        parser.push(decoder.decode(result.value, { stream: true }));
      }
      parser.push(decoder.decode()); parser.finish();
      if (!done) throw new Error('The audio stream ended before completion. Please retry.');
      const wav = encodeWav(chunks);
      if (!current()) return;
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
    <header className="topbar"><div className="brand"><span className="brand-mark">◒</span><span>sonora</span><span className="badge">VOICE STUDIO</span></div><div className="topbar-right">Text-to-speech workspace</div></header>
    <main className="workspace">
      <section className="hero"><div><p className="eyebrow">SONORA · CREATIVE AUDIO</p><h1>Bring your words<br /><em>to life.</em></h1><p className="hero-copy">Shape the delivery, choose a voice, and create a downloadable WAV narration from your script.</p></div><div className="hero-orb"><div className="orb-core" /><div className="wave wave-one" /><div className="wave wave-two" /><div className="wave wave-three" /></div></section>
      <section className="studio-grid">
         <div className="panel input-panel"><div className="panel-heading"><div><span className="step">01</span><h2>Write your script</h2></div><button className="sample-button" disabled={generating || quotaExhausted} onClick={() => setText(SAMPLE)}>Use sample <span>↗</span></button></div><div className="expression-bar"><label className="expression-entry"><span className="expression-label">EMOTION & DELIVERY TAGS</span><input aria-label="Emotion and delivery tags" type="text" value={expressionTags} disabled={generating || quotaExhausted} onChange={(e) => setExpressionTags(e.target.value)} placeholder="e.g. Warm, excited, whispering" /><small>{buildModulatedText('', expressionTags).trim() || 'No tags added'}</small></label></div><p className="expression-hint">Write one or more tags separated by commas. Brackets are added automatically.</p><div className={`textarea-wrap ${quotaExhausted ? 'quota-locked' : ''}`}><textarea aria-label="Script" aria-disabled={quotaExhausted} disabled={generating || quotaExhausted} onChange={(e) => setText(e.target.value)} value={text} placeholder="Paste or write anything you want to hear…" />{quotaExhausted && <p className="quota-lock-message" role="status">Daily word allowance used. Editing is locked until the allowance resets.</p>}<div className="textarea-footer"><span className={overLimit ? 'counter over' : 'counter'}>{count.toLocaleString()} <span>/ {limit ? limit.toLocaleString() : '—'} characters</span></span><span className="tag-hint">⌁ Includes expression tags · not a token quota</span></div></div><div className="quota-track"><div style={{ width: `${percent}%` }} /></div><p className={overDailyLimit ? 'daily-quota over' : 'daily-quota'}>{dailyWordQuota ? `${dailyWordQuota.used.toLocaleString()} / ${dailyWordQuota.limit.toLocaleString()} words used today · ${dailyWordQuota.remaining.toLocaleString()} remaining · resets at 00:00 UTC` : 'Loading daily word allowance…'}</p><p className="quota-disclaimer">Submitted words, including delivery tags, count even if generation fails or is cancelled. Visitors sharing a public IP share this allowance.</p>{overLimit && <p className="error-text">Text exceeds the selected engine's application character cap by {(count - limit).toLocaleString()} characters. Shorten your script.</p>}{overDailyLimit && <p className="error-text">This request exceeds the remaining daily word allowance. Shorten your script or wait for the UTC reset.</p>}</div>
        <aside className="panel settings-panel">
          <div className="panel-heading"><div><span className="step">02</span><h2>Voice settings</h2></div><span className="live-pill">STUDIO</span></div>
           <label>ENGINE<select value={selectedModel ? modelId : ''} disabled={generating || configStatus !== 'ready'} onChange={(e) => changeSelection('modelId', e.target.value)} aria-describedby="engine-description engine-notice">
             {!selectedModel && <option value="">{configStatus === 'loading' ? 'Loading engines…' : 'No engines available'}</option>}
             {(config?.models || []).map((model) => <option key={model.id} value={model.id}>{getModelPresentation(model).name}</option>)}
           </select></label>
           {selectedModel && modelPresentation && <div className="engine-description" id="engine-description">
             <div className="model-profile"><strong>{modelPresentation.profile}</strong><span>{selectedModel.characterLimit.toLocaleString()} character app limit</span></div>
             <p>{modelPresentation.description}</p>
             <p>Your audio streams as it is generated. A complete WAV is available when the run finishes.</p>
           </div>}
           <div className="model-note" id="engine-notice"><span>✦</span><span>AI can make mistakes and may not produce the exact output you expect. Model profile names are descriptive labels only; text is sent as written, and per-request character caps are separate from the daily word allowance.</span></div>
          <div className="config-status" role="status"><p>{configStatus === 'loading' ? 'Checking server configuration…' : configError || (config?.configured ? 'Server configured · Streaming available' : 'Server is not configured. Set up the server, then retry.')}</p><button className="sample-button" disabled={generating || configStatus === 'loading'} onClick={loadConfig}>Retry configuration ↗</button></div>
          <label>VOICE<select value={voice} disabled={availability.voiceDisabled} onChange={(e) => changeSelection('voice', e.target.value)}>{!voice && <option value="">No voices available</option>}{(config?.voices || []).map((item) => <option key={item} value={item}>{VOICE_LABELS[item] || 'Studio voice'}</option>)}</select></label>
          {config?.voices?.length > 0 && <p className="engine-description">Choose a voice by its studio display name. The selected voice setting is retained for generation.</p>}
          <div className="voice-preview"><div className="avatar">{VOICE_LABELS[voice]?.slice(0, 1) || '—'}</div><div><strong>{VOICE_LABELS[voice] || 'Choose a voice'}</strong><small>Studio voice</small></div><div className="mini-wave">▁▃▆▃▅▂▃</div></div>
          <button className="generate-button" disabled={availability.generateDisabled} aria-describedby="generation-requirements" onClick={generate}>{generating ? <><span className="spinner" /> Synthesizing…</> : <>Generate audio <span>→</span></>}</button>
          <p id="generation-requirements" className="engine-description" role="status">{availability.reason || 'Ready to generate using your selected engine and voice.'}</p>
          {error && <p className="error-text" role="alert">{error}</p>}
        </aside>
      </section>
      <section className={`output-panel ${audioUrl ? 'has-audio' : ''} ${generating ? 'is-generating' : ''}`}>
        <div className="output-label"><span className="step">03</span><div><h2>{audioUrl ? 'Your download is ready' : 'Audio output'}</h2><p role="status">{generating ? `Generating WAV · ${progress.completed} of ${progress.total || '…'} segments complete` : audioUrl ? 'Your narration is complete. Download the WAV file below.' : status === 'cancelled' ? 'Generation cancelled · No partial file saved' : status === 'error' ? 'Generation failed · No partial file saved' : 'Your completed WAV file will be available here.'}</p></div></div>
        {generating && <div className="generation-progress"><div className="progress-caption"><span>Generation progress</span><strong>{progressPercent}%</strong></div><progress aria-label="Generation progress" value={progressPercent} max="100" /></div>}
        <div className="output-controls">{generating && <button className="cancel-button" onClick={cancel}>Cancel generation</button>}{audioUrl && <a className="download-button" href={audioUrl} download="sonora-speech.wav">Download WAV ↓</a>}</div>
        {!audioUrl && !generating && <div className="empty-wave">{[...Array(32)].map((_, i) => <i key={i} style={{ height: `${10 + (i * 17) % 38}px` }} />)}</div>}
      </section>
      <footer><span>SONORA · VOICE STUDIO</span><span>Stream your narration · Download as WAV</span></footer>
    </main>
  </div>;
}
createRoot(document.getElementById('root')).render(<App />);
