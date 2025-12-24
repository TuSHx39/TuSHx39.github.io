/* =======================
 * 1. 常量
 * ======================= */
const A4_FREQ = 440;
const A4_MIDI = 69;
const FIRST_MIDI = 21;
const LAST_MIDI  = 108;
const WHITE_KEY_WIDTH = 40;

const settings = {
  volume: 0.5,            // 主音量 0~1
  baseFreq: 440,          // 基准频率 A4
  waveform: 'triangle',   // triangle / sine / sawtooth
  showNoteName: true,     // 是否显示音名
  showStaff: true,        // 是否显示五线谱
  invertPedal: false,     // 踏板反转
  togglePedal: false      // 踏板切换模式
};

/* =======================

 * 2. 音高系统
 * ======================= */
const NOTE_NAMES = [
  'C','C#','D','D#','E','F',
  'F#','G','G#','A','A#','B'
];

function midiToFreq(midi) {
  return A4_FREQ * Math.pow(2, (midi - A4_MIDI) / 12);
}

/* =======================
 * 3. Audio Context
 * ======================= */
const AudioContext = window.AudioContext || window.webkitAudioContext;
const audioCtx = new (window.AudioContext || window.webkitAudioContext)();

// 主音量（总线）
// 主音量
const masterGain = audioCtx.createGain();
masterGain.gain.value = settings.volume;
masterGain.connect(audioCtx.destination);

// 原来 osc → gain → destination
// 改为 osc → gain → masterGain


/* =======================
 * 4. 状态管理
 * ======================= */
let sustainOn = false;
const heldKeys = new Set();
const activeNotes = new Map();

const currentNoteEl = document.getElementById('current-note');
const currentNoteCheckbox = document.getElementById('note-name-toggle');
/* =======================
 * 5. Note On / Off
 * ======================= */
function noteOn(midi) {
  if (activeNotes.has(midi)) return;

  const now = audioCtx.currentTime;
  const freq = midiToFreq(midi);

  const osc = audioCtx.createOscillator();
  osc.type = 'triangle';
  osc.frequency.value = freq;

  const gain = audioCtx.createGain();
  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.linearRampToValueAtTime(0.4, now + 0.01); // 单音最大响度也稍微收紧


  osc.connect(gain).connect(masterGain); // ❗ 不再直接 connect(destination)
  osc.start(now);

  activeNotes.set(midi, { osc, gain });
  heldKeys.add(midi);

  // 显示当前按下音名（多音）
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

/* =======================
 * 6. 当前按下音名显示
 * ======================= */
function updateCurrentNotes() {
  if (!currentNoteCheckbox.checked) return; // 不显示时直接返回

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
/* =======================
 * 7. 键盘生成
 * ======================= */
function buildKeyboard() {
  const piano = document.getElementById('piano');
  piano.innerHTML = '';

  let whiteIndex = 0;

  for (let midi = FIRST_MIDI; midi <= LAST_MIDI; midi++) {
    const note = NOTE_NAMES[midi % 12];
    const octave = Math.floor(midi / 12) - 1; // MIDI 21 -> A0
    const fullNoteName = note + octave; // e.g., C4, D4

    if (!note.includes('#')) {
      const white = document.createElement('div');
      white.className = 'key white';
      white.dataset.midi = midi;
      white.dataset.note = fullNoteName; // 存储完整音高

      // 只标 C
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
/* =======================
 * 8. 交互
 * ======================= */
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
/* =======================
 * 9. 初始化
 * ======================= */

buildKeyboard();
bindEvents();
bindSettingsPanel();
settingChanged();

const settingsBtn = document.getElementById('settings-btn');
const settingsPanel = document.getElementById('settings-panel');

let settingsOpen = false;

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

// 点击齿轮
settingsBtn.addEventListener('click', e => {
  e.stopPropagation();
  settingsOpen ? closeSettings() : openSettings();
});

// 点击空白处关闭
document.addEventListener('click', e => {
  if (!settingsOpen) return;

  // 点到面板或按钮内部不关闭
  if (
    settingsPanel.contains(e.target) ||
    settingsBtn.contains(e.target)
  ) return;

  closeSettings();
});

// ESC 键关闭
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && settingsOpen) {
    closeSettings();
  }
});
