export const MODEL_PRESENTATION = Object.freeze({
  'gemini-2.5-flash-native-audio-preview-12-2025': {
    name: 'Studio Quality',
    profile: 'Studio profile',
    description: 'A studio-style profile label for voice generation.'
  },
  'gemini-3-flash-live': {
    name: 'Lite',
    profile: 'Lite profile',
    description: 'A lightweight profile label for everyday voice generation.'
  },
  'gemini-3.5-live-translate': {
    name: 'Translate',
    profile: 'Translation profile',
    description: 'A translation-oriented profile label.'
  },
  'gemini-3.5-transcribe-live': {
    name: 'Transcribe',
    profile: 'Transcription profile',
    description: 'A transcription-oriented profile label.'
  },
  'gemini-3.8-live': {
    name: 'Balanced',
    profile: 'Balanced profile',
    description: 'A general-purpose profile label.'
  },
  'gemini-3.8-live-extended-thinking': {
    name: 'Enhanced Thinking',
    profile: 'Enhanced thinking profile',
    description: 'An extended-reasoning profile label.'
  }
});

export const VOICE_LABELS = Object.freeze({
  Zephyr: 'Mira',
  Puck: 'Arin',
  Charon: 'Kiran',
  Kore: 'Nila',
  Fenrir: 'Dev',
  Leda: 'Tara',
  Orus: 'Ravi',
  Aoede: 'Isha',
  Callirrhoe: 'Anya',
  Autonoe: 'Neel',
  Enceladus: 'Sana',
  Iapetus: 'Veer',
  Umbriel: 'Rhea',
  Algieba: 'Kabir',
  Despina: 'Leela',
  Erinome: 'Om',
  Algenib: 'Meera',
  Rasalgethi: 'Adi',
  Laomedeia: 'Noor',
  Achernar: 'Asha',
  Alnilam: 'Rohan',
  Schedar: 'Diya',
  Gacrux: 'Aman',
  Pulcherrima: 'Maya',
  Achird: 'Ram',
  Zubenelgenubi: 'Zoya',
  Vindemiatrix: 'Arjun',
  Sadachbia: 'Ira',
  Sadaltager: 'Eshan',
  Sulafat: 'Kavya'
});

export function getModelPresentation(model) {
  return MODEL_PRESENTATION[model.id] || {
    name: 'Studio profile',
    profile: 'Studio profile',
    description: 'A descriptive profile label for this model.'
  };
}
