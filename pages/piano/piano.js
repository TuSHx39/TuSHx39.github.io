const A4_MIDI = 69;
const FIRST_MIDI = 21;
const LAST_MIDI  = 108;
const WHITE_KEY_WIDTH = 40;
const A4_FREQ = 440;
const settings = {
  volume: 0.3,            
  baseFreq: 440,          
  waveform: 'triangle',   
  showNoteName: true,     
  showStaff: true,        
  invertPedal: false,     
  togglePedal: false      
};

const NOTE_NAMES = [
  'C','C#','D','D#','E','F',
  'F#','G','G#','A','A#','B'
];

function midiToFreq(midi) {
  return A4_FREQ * Math.pow(2, (midi - A4_MIDI) / 12);
}


const AudioContext = window.AudioContext || window.webkitAudioContext;
const audioCtx = new (window.AudioContext || window.webkitAudioContext)();

// 主音量
const masterGain = audioCtx.createGain();
masterGain.gain.value = settings.volume;
masterGain.connect(audioCtx.destination);

let sustainOn = false;
const heldKeys = new Set();
const activeNotes = new Map();

let settingsOpen = false;
const settingsBtn = document.getElementById('settings-btn');
const settingsPanel = document.getElementById('settings-panel');

const currentNoteEl = document.getElementById('current-note');
const currentNoteCheckbox = document.getElementById('note-name-toggle');



//音符播放
function noteOn(midi) {
  if (activeNotes.has(midi)) return;

  const now = audioCtx.currentTime;
  const freq = midiToFreq(midi);

  const osc = audioCtx.createOscillator();
  osc.type = 'triangle';
  osc.frequency.value = freq;

  const gain = audioCtx.createGain();
  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.linearRampToValueAtTime(0.4, now + 0.01); 


  osc.connect(gain).connect(masterGain); 
  osc.start(now);

  activeNotes.set(midi, { osc, gain });
  heldKeys.add(midi);

// 显示当前按下音名
  updateCurrentNotes();
}

function noteOff(midi) {
  if (sustainOn) return;
  releaseNote(midi);
  heldKeys.delete(midi);
  updateCurrentNotes();
}

function releaseNote(midi) {
  const note = activeNotes.get(midi);
  if (!note) return;

  const now = audioCtx.currentTime;
  note.gain.gain.cancelScheduledValues(now);
  note.gain.gain.setValueAtTime(note.gain.gain.value, now);
  note.gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.25);
  note.osc.stop(now + 0.3);

  activeNotes.delete(midi);
}

function releaseSustainedNotes() {
  activeNotes.forEach((_, midi) => {
    if (!heldKeys.has(midi)) releaseNote(midi);
  });
}

//音名显示
function updateCurrentNotes() {
  if (!currentNoteCheckbox.checked) return; 

  if (heldKeys.size === 0) {
    currentNoteEl.textContent = '当前音: -';
    return;
  }

  const notes = Array.from(heldKeys)
    .sort((a,b)=>a-b)
    .map(midi=>{
      const key = document.querySelector(`.key[data-midi='${midi}']`);
      return key ? key.dataset.note : '';
    })
    .filter(n=>n);

  currentNoteEl.textContent = '当前音: ' + notes.join(' , ');
}

//键盘生成
function buildKeyboard() {
  const piano = document.getElementById('piano');
  piano.innerHTML = '';

  let whiteIndex = 0;

  for (let midi = FIRST_MIDI; midi <= LAST_MIDI; midi++) {
    const note = NOTE_NAMES[midi % 12];
    const octave = Math.floor(midi / 12) - 1; 
    const fullNoteName = note + octave; 

    if (!note.includes('#')) {
      const white = document.createElement('div');
      white.className = 'key white';
      white.dataset.midi = midi;
      white.dataset.note = fullNoteName; // 存储完整音高

      // 标注C键
      const label = document.createElement('span');
      label.className = 'note-label';
      label.textContent = note === 'C' ? fullNoteName : '';
      white.appendChild(label);

      piano.appendChild(white);

      // 添加黑键
      if (['C','D','F','G','A'].includes(note) && midi < LAST_MIDI) {
        const black = document.createElement('div');
        black.className = 'key black';
        black.dataset.midi = midi + 1;
        const blackNote = NOTE_NAMES[(midi + 1) % 12];
        const blackOctave = Math.floor((midi + 1) / 12) - 1;
        black.dataset.note = blackNote + blackOctave;

        black.style.left =
          whiteIndex * WHITE_KEY_WIDTH + WHITE_KEY_WIDTH * 0.7 + 'px';

        piano.appendChild(black);
      }

      whiteIndex++;
    }
  }
  piano.style.width = whiteIndex * WHITE_KEY_WIDTH + 'px';
  
  requestAnimationFrame(() => {
    const wrapper = document.querySelector('.piano-wrapper');
    if (!wrapper) return;

    wrapper.scrollLeft =
      (wrapper.scrollWidth - wrapper.clientWidth) / 2;
  });
}

//交互
function bindEvents() {
  document.addEventListener('mousedown', e => {
    const key = e.target.closest('.key');
    if (!key) return;

    audioCtx.resume();
    const midi = Number(key.dataset.midi);
    noteOn(midi);
  });

  document.addEventListener('mouseup', () => {
    heldKeys.forEach(midi => noteOff(midi));
  });

  window.addEventListener('blur', () => {
    heldKeys.clear();
    activeNotes.forEach((_, midi)=>releaseNote(midi));
    updateCurrentNotes();
  });

  // 踏板
  document.addEventListener('keydown', e => {
    if (e.code === 'Space' && !sustainOn) {
      e.preventDefault();
      sustainOn = true;
      document.body.classList.add('sustain-on');
    }
  });
  document.addEventListener('keyup', e => {
    if (e.code === 'Space') {
      e.preventDefault();
      sustainOn = false;
      document.body.classList.remove('sustain-on');
      releaseSustainedNotes();
      updateCurrentNotes();
    }
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      settingsPanel.classList.remove('open');
      document.body.classList.remove('settings-open');
    }
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && settingsOpen) {
      closeSettings();
    }
  }); 
}

function bindSettingsPanel() {
  const btn = document.getElementById('settings-btn');
  const panel = document.getElementById('settings-panel');

  if (!btn || !panel) return;

  btn.addEventListener('click', () => {
    panel.classList.toggle('open');
  });
}

function settingChanged() {
  currentNoteCheckbox.addEventListener('change', () => {
    currentNoteEl.style.visibility = currentNoteCheckbox.checked ? 'visible' : 'hidden';
  });
}

function openSettings() {
  settingsOpen = true;
  settingsPanel.classList.add('open');
  settingsBtn.classList.add('active');
}

function closeSettings() {
  settingsOpen = false;
  settingsPanel.classList.remove('open');
  settingsBtn.classList.remove('active');
}


buildKeyboard();
bindEvents();
bindSettingsPanel();
settingChanged();
