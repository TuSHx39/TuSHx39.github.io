const A4_MIDI = 69;
const FIRST_MIDI = 21;
const LAST_MIDI  = 108;
const WHITE_KEY_WIDTH = 40;
const settings = {                     
  showNoteName: true,     
  showStaff: true,        
  invertPedal: false,     
  togglePedal: false      
};

const NOTE_NAMES = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];

let isMouseDown = false;
let sustainOn = false;
let lastMidi = null;
let spacePressed = false;
const currentChord = [];
const heldKeys = new Set();
const activeNotes = new Map();

const DECAY_NORMAL = 6 ;
const DECAY_FAST   = 0.4;

let settingsOpen = false;
const settingsBtn = document.getElementById('settings-btn');
const settingsPanel = document.getElementById('settings-panel');

const volumeSlider = document.getElementById('volume-slider');
let volume = parseFloat(volumeSlider.value);

const baseFreqInput = document.getElementById('base-freq-input');
let baseFreq = parseFloat(baseFreqInput.value);

const waveFormSelect = document.getElementById('waveform-select');
let waveForm = waveFormSelect.value;

const currentNoteEl = document.getElementById('current-note');
const currentNoteCheckbox = document.getElementById('note-name-toggle');

const pianoWrapper = document.querySelector('.piano-wrapper');
const pedal = document.getElementById('pedal');
const pedalToggleCheckbox = document.getElementById('pedal-toggle');
const invertPedalCheckbox = document.getElementById('invert-pedal-toggle'); 
const togglePedalCheckbox = document.getElementById('toggle-pedal-toggle');

// 主音量
const AudioContext = window.AudioContext || window.webkitAudioContext;
const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
const masterGain = audioCtx.createGain();
masterGain.gain.value = volume;
masterGain.connect(audioCtx.destination);

// 计算频率
function midiToFreq(midi) {
  return baseFreq * Math.pow(2, (midi - A4_MIDI) / 12);
}

//音符播放
function noteOn(midi) {
  const now = audioCtx.currentTime;
  const freq = midiToFreq(midi);

  // 如果音符已经存在（处于延音中），先释放旧音符
  if (activeNotes.has(midi)) {
    releaseNoteFast(midi);
  }

  const osc = audioCtx.createOscillator();
  osc.type = waveForm;
  osc.frequency.value = freq;

  const gain = audioCtx.createGain();
  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.linearRampToValueAtTime(0.4, now + 0.01); 

  osc.connect(gain).connect(masterGain);
  osc.start(now);

  activeNotes.set(midi, { osc, gain });
  heldKeys.add(midi);

  // 延音阶段
  const decayTime = sustainOn ? DECAY_NORMAL : DECAY_NORMAL; // 按键延音时间
  gain.gain.exponentialRampToValueAtTime(0.0001, now + decayTime);
  osc.stop(now + decayTime + 0.05);

  updateCurrentNotes();
  
}

//音符释放
function noteOff(midi) {
  heldKeys.delete(midi);

  if (!activeNotes.has(midi)) return;

  if (!sustainOn) {
    // 踏板关闭，快速释放
    releaseNoteFast(midi);
  }
  updateCurrentNotes();
}

// 快速释放音符
function releaseNoteFast(midi) {
  const note = activeNotes.get(midi);
  if (!note) return;

  const now = audioCtx.currentTime;
  note.gain.gain.cancelScheduledValues(now);
  note.gain.gain.setValueAtTime(note.gain.gain.value, now);
  note.gain.gain.exponentialRampToValueAtTime(0.0001, now + DECAY_FAST);
  note.osc.stop(now + DECAY_FAST + 0.05);

  activeNotes.delete(midi);
}

// 释放所有延音音符
function releaseSustainedNotes() {
  const now = audioCtx.currentTime;

  activeNotes.forEach((noteObj, midi) => {
    // 松键，快速释放
    if (!heldKeys.has(midi)) {
      noteObj.gain.gain.cancelScheduledValues(now);
      noteObj.gain.gain.setValueAtTime(noteObj.gain.gain.value, now);
      noteObj.gain.gain.exponentialRampToValueAtTime(0.0001, now + DECAY_FAST);
      noteObj.osc.stop(now + DECAY_FAST + 0.05);
      activeNotes.delete(midi);
    }
  });
}

//音名显示
function updateCurrentNotes() {
  if (!currentNoteCheckbox.checked) return;

  if (heldKeys.size === 0 && activeNotes.size === 0) {
    currentNoteEl.textContent = '当前音: -';
    return;
  }


  const allMidi = new Set([...heldKeys, ...activeNotes.keys()]);

  const notes = Array.from(allMidi)
    .sort((a, b) => a - b)
    .map(midi => {
      const key = document.querySelector(`.key[data-midi='${midi}']`);
      return key ? key.dataset.note : '';
    })
    .filter(n => n);
  
  currentNoteEl.textContent = '当前音: ' + notes.join(' , ');
}

// 和弦识别
function chordRecognizer() {
  const allMidi = new Set([...heldKeys, ...activeNotes.keys()]);
  const notes = Array.from(allMidi).sort((a, b) => a - b);
  let relativeNotes = notes.map(x => x - notes[0]);
  const seen = new Set();
  relativeNotes = relativeNotes.filter(x => {
    const r = ((x % 12) + 12) % 12; // 防止负数
    if (seen.has(r)) return false;
    seen.add(r);
    return true;
  });
  function triad(){

  }
  console.log('当前和弦音: ' + relativeNotes.join(' , '));
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

//打开设置
function openSettings() {
  settingsOpen = true;
  settingsPanel.classList.add('open');
  settingsBtn.classList.add('active');
}

//关闭设置
function closeSettings() {
  settingsOpen = false;
  settingsPanel.classList.remove('open');
  settingsBtn.classList.remove('active');
}

//交互
function bindEvents() {
  // 禁止选中文本
  piano.addEventListener('mousedown', e => e.preventDefault());
  piano.addEventListener('mousemove', e => e.preventDefault());
  // 鼠标按下
  piano.addEventListener('mousedown', e => {
    const key = e.target.closest('.key');
    if (!key) return;

    audioCtx.resume();
    isMouseDown = true;

    const midi = Number(key.dataset.midi);
    noteOn(midi);
    heldKeys.add(midi);     // 实际按下的键加入 heldKeys
    updateCurrentNotes();   // 更新显示
    chordRecognizer();
    lastMidi = null;
  });

  // // 鼠标移动划过琴键（滑动奏琴）
  // piano.addEventListener('mousemove', e => {
  //   if (!isMouseDown) return;
  //   const key = e.target.closest('.key');
  //   if (!key) return;

  //   const midi = Number(key.dataset.midi);
  //   if (lastMidi === midi) return;

  //   // 松开上一个滑动音符
  //   if (lastMidi !== null){
  //     if (sustainOn == false) {
  //       releaseNoteFast(lastMidi);
  //   }}

  //   // 触发新滑动音符
  //   noteOn(midi);
  //   lastMidi = midi;

  //   // **立即清除 currentNoteEl 中可能存在的滑动音符**
  //   // currentNoteEl 只显示 heldKeys，所以直接调用 updateCurrentNotes
  //   updateCurrentNotes();
  // });

  // 鼠标释放
  piano.addEventListener('mouseup', () => {
    isMouseDown = false;

    if (lastMidi !== null) {
      releaseNoteFast(lastMidi);
      lastMidi = null;
    }

    // 松开鼠标时释放实际按下的键
    heldKeys.forEach(midi => noteOff(midi));
    heldKeys.clear();
    updateCurrentNotes(); // 更新显示
  });

  // 离开窗口释放所有音符
  window.addEventListener('blur', () => {
    isMouseDown = false;
    heldKeys.clear();
    activeNotes.forEach((_, midi) => releaseNote(midi));
    updateCurrentNotes();
  });
  // 按下踏板
  document.addEventListener('keydown', e => {
    if (e.code !== 'Space') return;
    e.preventDefault();
    if (spacePressed) return; 
    spacePressed = true;
    if (!togglePedalCheckbox.checked) {
      if (invertPedalCheckbox.checked) {
        // 反转模式：按下空格 → 快速释放延音
        document.body.classList.remove('sustain-on');
        releaseSustainedNotes();
        updateCurrentNotes();
      } else {
        // 正常模式：按下空格 → 开启延音
        sustainOn = true;
        document.body.classList.add('sustain-on');
      }
    }
    else{
      if (sustainOn) {
        document.body.classList.remove('sustain-on');
        releaseSustainedNotes();
        updateCurrentNotes();
        sustainOn = false;
      }
      else{
        document.body.classList.add('sustain-on');
        sustainOn = true;
      }
    }
  });

  document.addEventListener('keyup', e => {
    if (e.code !== 'Space') return;
    spacePressed = false;
    if (togglePedalCheckbox.checked) return; 
    e.preventDefault();

    if (invertPedalCheckbox.checked) {
      // 反转模式
      sustainOn = true;
      document.body.classList.add('sustain-on');
    } else {
      // 正常模式
      sustainOn = false;
      document.body.classList.remove('sustain-on');
      releaseSustainedNotes();
      updateCurrentNotes();
    }
  });
  // ESC关闭设置面板
  document.addEventListener('keydown', e => {``
    if (!settingsOpen) return;
    if (e.key === 'Escape') {
      closeSettings();
    }
  });
}

//设置面板开关
function bindSettingsPanel() {
  if (!settingsBtn || !settingsPanel) return;
  settingsBtn.addEventListener('click', () => {
    if (settingsOpen) {
      closeSettings();
      return;
    }
    else{
      openSettings();
    }
  });
}

//设置变更
function settingChanged() {
  // 显示音名
  currentNoteCheckbox.addEventListener('change', () => {
    currentNoteEl.style.visibility = currentNoteCheckbox.checked ? 'visible' : 'hidden';
  });
  // 基准频率
  baseFreqInput.addEventListener('input', () => {
    baseFreq = parseFloat(baseFreqInput.value);
  });
  // 音量滑块
  volumeSlider.addEventListener('input', () => {
    volume = parseFloat(volumeSlider.value);
    masterGain.gain.value = volume;
  });
  // 波形选择
  waveFormSelect.addEventListener('change', () => {
    waveForm = waveFormSelect.value;
  });
  // 踏板开关
  pedalToggleCheckbox.addEventListener('change', () => {
    pedal.style.visibility = pedalToggleCheckbox.checked ? 'visible' : 'hidden';
    pianoWrapper.style.bottom = pedalToggleCheckbox.checked ? '50px' : '0px';
    currentNoteEl.style.bottom = pedalToggleCheckbox.checked ? '255px' : '205px';
  });
  // 踏板反转
  invertPedalCheckbox.addEventListener('change', () => {
    sustainOn = invertPedalCheckbox.checked ? true : false;
    if (sustainOn) {
      document.body.classList.add('sustain-on');
    } else {
      document.body.classList.remove('sustain-on');
    }
  });
  // 踏板切换
  togglePedalCheckbox.addEventListener('change', () => {
    sustainOn = false;
    document.body.classList.remove('sustain-on');
    togglePedal = togglePedalCheckbox.checked;
  });
}

//初始化
function init() {
  buildKeyboard();
  bindEvents();
  bindSettingsPanel();
  settingChanged();
}

document.addEventListener('DOMContentLoaded', () => {
  init();
});

