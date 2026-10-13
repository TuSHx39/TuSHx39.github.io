import { DEFAULT_STATE, PRESETS, SOUNDS, createBeat, createPattern, getPattern, compileBar, normalizeState, serializeState, parseState } from './rhythm.js';
import { MetronomeEngine } from './audio.js';

const $ = (id) => document.getElementById(id);
const setText = (id, value) => { if ($(id).textContent !== value) $(id).textContent = value; };
const STORAGE_KEY = 'tushx39.metronome.v1';
const divisions = [1, 2, 3, 4, 5, 6, 7, 8, 12, 16];
const kinds = { normal: '普通', accent: '重音', rest: '休止' };
let state = loadState();
let playing = false;
let starting = false;
let tempoEditing = false;
let frameId = 0;
let selected = null;
let paintTool = 'cycle';
let lastBar = null;
let lastElapsed = 0;
let lastBars = 0;
let taps = [];
let tapTimeout;

function loadState() {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return normalizeState(stored ? JSON.parse(stored) : structuredClone(DEFAULT_STATE));
  } catch {
    return normalizeState(structuredClone(DEFAULT_STATE));
  }
}

function save() {
  try {
    localStorage.setItem(STORAGE_KEY, serializeState(state));
    $('save-status').hidden = true;
    return true;
  } catch {
    $('save-status').textContent = '浏览器无法保存设置，可导出节奏保留';
    $('save-status').hidden = false;
    return false;
  }
}

function error(message) {
  $('error-message').textContent = message || '';
  $('error-message').hidden = !message;
}

function update(mutator, { editor = false } = {}) {
  mutator(state);
  state = normalizeState(state);
  if (playing) engine.refresh();
  save();
  renderControls();
  if (editor) renderEditor();
  if (!playing) renderRail(compileBar(state, 0));
}

function makeCustom() {
  if (state.preset !== 'custom') state.pattern = getPattern(state);
  state.preset = 'custom';
}

function selectPreset(id) {
  selected = null;
  update((s) => {
    s.preset = id;
    if (id !== 'custom') s.pattern = createPattern(s.beats, id, s.swing);
  }, { editor: true });
}

function presetNotation(id) {
  const note = (x, flags = 0) => {
    const stem = x + 4;
    let glyph = `<ellipse cx="${x}" cy="44" rx="5.3" ry="3.7" transform="rotate(-20 ${x} 44)"/><path d="M${stem} 43V18" fill="none" stroke="currentColor" stroke-width="2"/>`;
    for (let flag = 0; flag < flags; flag++) {
      const y = 18 + flag * 7;
      glyph += `<path d="M${stem} ${y}c9 4 13 10 5 17 4-8 0-10-5-10Z"/>`;
    }
    return glyph;
  };
  const beam = (from, to, level = 0) => `<rect x="${from + 3}" y="${18 + level * 6}" width="${to - from + 2}" height="3.5"/>`;
  const group = (xs, beams = 1) => xs.map(x => note(x)).join('')
    + Array.from({ length: beams }, (_, level) => beam(xs[0], xs.at(-1), level)).join('');
  const tuplet = (number) => `<path d="M10 11V6H43M64 6H97V11" fill="none" stroke="currentColor" stroke-width="1.2"/><text x="54" y="10" text-anchor="middle" font-family="Arial,sans-serif" font-size="11" font-weight="600">${number}</text>`;
  const rest = (x, flags = 1) => `<path d="M${x + 8} 24l-7 23" fill="none" stroke="currentColor" stroke-width="2"/>`
    + Array.from({ length: flags }, (_, flag) => `<circle cx="${x}" cy="${26 + flag * 7}" r="2.8"/><path d="M${x} ${28 + flag * 7}q4 1 7-4" fill="none" stroke="currentColor" stroke-width="2"/>`).join('');
  const glyphs = {
    quarter: () => note(49),
    eighth: () => group([25, 76]),
    sixteenth: () => group([14, 39, 64, 89], 2),
    'eighth-sixteenth': () => group([18, 59, 87]) + beam(59, 87, 1),
    'sixteenth-eighth': () => group([18, 46, 87]) + beam(18, 46, 1),
    dotted: () => group([25, 76]) + beam(67, 76, 1) + '<circle cx="37" cy="43" r="2"/>',
    swing: () => note(25) + note(76, 1) + tuplet(3),
    triplet: () => group([19, 52, 85]) + tuplet(3),
    'triplet-skip': () => note(17, 1) + rest(51) + note(83, 1) + tuplet(3),
    syncopated: () => rest(12, 2) + note(34, 2) + rest(62, 2) + note(84, 2),
    sextuplet: () => group([10, 26, 42, 58, 74, 90], 2) + tuplet(6),
    custom: () => '<circle cx="34" cy="29" r="3.5"/><circle cx="54" cy="29" r="3.5"/><circle cx="74" cy="29" r="3.5"/>',
  };
  return `<svg class="rhythm-notation" viewBox="0 0 108 58" aria-hidden="true" focusable="false" fill="currentColor">${glyphs[id]()}</svg>`;
}

function renderControls() {
  document.querySelector('.app-shell').classList.toggle('basic', !state.advanced);
  $('advanced-panel').hidden = !state.advanced;
  for (const [id, active] of [['basic-mode', !state.advanced], ['advanced-mode', state.advanced]]) {
    $(id).classList.toggle('selected', active);
    $(id).setAttribute('aria-pressed', active);
  }
  renderTempo(engine.getPosition()?.bpm ?? state.bpm);
  $('beats').value = state.beats;
  $('accent').checked = state.accent;
  $('volume').value = Math.round(state.volume * 100);
  $('volume-label').textContent = `${Math.round(state.volume * 100)}%`;
  $('swing').value = state.swing;
  $('swing-label').textContent = `${state.swing} : ${100 - state.swing}`;
  $('editor-meter').textContent = `${state.beats} 拍`;
  document.querySelectorAll('[data-preset]').forEach((button) => {
    const active = button.dataset.preset === state.preset;
    button.classList.toggle('selected', active);
    button.setAttribute('aria-pressed', active);
  });
  document.querySelectorAll('[data-sound]').forEach((button) => {
    const active = button.dataset.sound === state.sound;
    button.classList.toggle('selected', active);
    button.setAttribute('aria-pressed', active);
  });
  const practiceFields = { 'count-in': 'countIn', 'mute-enabled': 'muteEnabled', 'play-bars': 'playBars', 'mute-bars': 'muteBars', 'ramp-enabled': 'rampEnabled', 'ramp-every': 'rampEvery', 'ramp-step': 'rampStep', 'ramp-max': 'rampMax', 'stop-enabled': 'stopEnabled', 'stop-bars': 'stopBars' };
  for (const [id, key] of Object.entries(practiceFields)) {
    if ($(id).type === 'checkbox') $(id).checked = state.practice[key];
    else $(id).value = state.practice[key];
  }
  $('mute-options').hidden = !state.practice.muteEnabled;
  $('ramp-options').hidden = !state.practice.rampEnabled;
  $('stop-options').hidden = !state.practice.stopEnabled;
  renderInspector();
}

function renderTempo(bpm, preserveInput = false) {
  // Keep the stored starting tempo separate from the actual ramp speed.
  if (!preserveInput || !tempoEditing) {
    if ($('bpm').value !== String(bpm)) $('bpm').value = bpm;
  }
  if ($('tempo-range').value !== String(bpm)) $('tempo-range').value = bpm;
}

function renderRail(plan) {
  const beats = plan.beats;
  $('beat-labels').replaceChildren();
  $('rail-beats').replaceChildren();
  $('rail-notes').replaceChildren();
  for (let beat = 0; beat < beats; beat++) {
    const label = document.createElement('div');
    label.className = 'beat-label';
    label.textContent = beat + 1;
    $('beat-labels').append(label);
    const segment = document.createElement('div');
    segment.className = 'rail-beat';
    $('rail-beats').append(segment);
  }
  const occupiedSlots = new Map();
  for (const event of plan.events) occupiedSlots.set(event.beat, Math.max(occupiedSlots.get(event.beat) || 1, event.cell + 1));
  for (const event of plan.events) {
    const tick = document.createElement('span');
    tick.className = `rail-note${event.accent ? ' accent' : ''}`;
    tick.style.left = `${event.offset / beats * 100}%`;
    const slotWidth = $('rhythm-rail').clientWidth / beats / occupiedSlots.get(event.beat);
    tick.style.width = `${Math.max(1.5, Math.min(6, slotWidth * .45))}px`;
    tick.style.transform = event.offset === 0 ? 'none' : 'translateX(-50%)';
    tick.style.opacity = .35 + event.velocity * .65;
    tick.setAttribute('aria-hidden', 'true');
    $('rail-notes').append(tick);
  }
  $('rhythm-caption').hidden = !plan.countIn && !plan.muted;
  $('rhythm-caption').textContent = plan.countIn ? '预备小节' : plan.muted ? '静音练习' : '';
  $('position-label').textContent = `第 1 拍 / ${beats} 拍`;
}

function renderEditor() {
  const scrollPositions = new Map(Array.from(document.querySelectorAll('.beat-row')).map((row) => [row.dataset.beatRow, row.querySelector('.beat-cells').scrollLeft]));
  const pattern = getPattern(state);
  $('beat-editor').replaceChildren();
  pattern.forEach((beat, beatIndex) => {
    const row = document.createElement('div');
    row.className = 'beat-row';
    row.dataset.beatRow = beatIndex;
    const index = document.createElement('span');
    index.className = 'beat-index';
    index.textContent = beatIndex + 1;
    const select = document.createElement('select');
    select.className = 'division-select';
    select.dataset.divisionBeat = beatIndex;
    select.setAttribute('aria-label', `第 ${beatIndex + 1} 拍细分`);
    for (const count of divisions) {
      const option = document.createElement('option');
      option.value = count;
      option.textContent = count === 1 ? '每拍一次' : `${count} 等分${count === 3 ? ' · 连音' : ''}`;
      select.append(option);
    }
    select.value = beat.divisions;
    const cells = document.createElement('div');
    cells.className = 'beat-cells';
    beat.cells.forEach((cell, cellIndex) => {
      const button = document.createElement('button');
      const isSelected = selected?.beat === beatIndex && selected?.cell === cellIndex;
      button.type = 'button';
      button.className = `note-cell ${cell.kind}${isSelected ? ' selected' : ''}`;
      button.dataset.beat = beatIndex;
      button.dataset.cell = cellIndex;
      button.dataset.index = cellIndex + 1;
      button.setAttribute('aria-label', `第 ${beatIndex + 1} 拍第 ${cellIndex + 1} 格，${kinds[cell.kind]}，力度 ${cell.velocity}%`);
      button.setAttribute('aria-pressed', isSelected);
      button.textContent = ({ normal: '●', accent: '◆', rest: '—' })[cell.kind];
      button.title = `${kinds[cell.kind]} · ${cell.velocity}% · ${SOUNDS.find((s) => s.id === cell.sound)?.label || '跟随全局音色'}`;
      cells.append(button);
    });
    const swing = document.createElement('button');
    swing.type = 'button';
    swing.className = `beat-swing${beat.swing ? ' selected' : ''}`;
    swing.dataset.swingBeat = beatIndex;
    swing.textContent = '∿';
    swing.setAttribute('aria-label', `第 ${beatIndex + 1} 拍 Swing`);
    swing.setAttribute('aria-pressed', beat.swing);
    swing.title = '对偶数细分应用 Swing';
    swing.disabled = beat.divisions % 2 !== 0;
    row.append(index, select, cells, swing);
    $('beat-editor').append(row);
    cells.scrollLeft = scrollPositions.get(String(beatIndex)) || 0;
  });
  renderInspector();
}

function renderInspector() {
  const cell = selected && state.pattern[selected.beat]?.cells[selected.cell];
  $('note-inspector').hidden = !cell;
  if (!cell) return;
  $('selected-note-label').textContent = `第 ${selected.beat + 1} 拍 · 第 ${selected.cell + 1} 格`;
  $('note-kind').value = cell.kind;
  $('note-velocity').value = cell.velocity;
  $('velocity-label').textContent = `${cell.velocity}%`;
  $('note-velocity').disabled = cell.kind === 'rest';
  $('note-sound').value = cell.sound;
  $('note-sound').disabled = cell.kind === 'rest';
}

function setPlaybackUI() {
  $('play-button').classList.toggle('playing', playing);
  $('play-button').querySelector('use').setAttribute('href', playing ? '#i-stop' : '#i-play');
  $('play-button').querySelector('span').textContent = starting ? '准备中' : playing ? '停止' : '开始';
  $('play-button').disabled = starting;
  $('status-dot').classList.toggle('playing', playing);
  if (!playing) $('playback-status').textContent = '已停止';
}

const engine = new MetronomeEngine({
  getState: () => structuredClone(state),
  onBar: (position) => {
    lastBar = position.barIndex;
    renderRail(position);
    renderTempo(position.bpm, true);
  },
  onStop: (reason) => {
    playing = false;
    starting = false;
    tempoEditing = false;
    cancelAnimationFrame(frameId);
    lastBar = null;
    renderTempo(state.bpm);
    $('rail-fill').style.width = '0%';
    $('playhead').style.opacity = '0';
    document.querySelectorAll('.active, .sounding').forEach((el) => el.classList.remove('active', 'sounding'));
    setPlaybackUI();
    if (reason === 'complete') $('playback-status').textContent = '练习完成';
    renderRail(compileBar(state, 0));
  },
  onError: (message) => error(typeof message === 'string' ? message : message.message),
});

function animate() {
  if (!playing) return;
  const position = engine.getPosition();
  if (position) {
    if (lastBar !== position.barIndex) {
      lastBar = position.barIndex;
      renderRail(position);
    }
    $('rail-fill').style.width = `${position.progress * 100}%`;
    $('playhead').style.left = `${position.progress * 100}%`;
    $('playhead').style.opacity = '1';
    setText('position-label', `第 ${position.beat + 1} 拍 / ${position.beats} 拍`);
    setText('playback-status', position.countIn ? '预备中' : position.muted ? '静音练习' : `播放中 · ${position.bpm} BPM`);
    renderTempo(position.bpm, true);
    document.querySelectorAll('.beat-label').forEach((el, i) => el.classList.toggle('active', i === position.beat));
    document.querySelectorAll('.beat-index').forEach((el, i) => el.classList.toggle('active', i === position.beat));
    document.querySelectorAll('.note-cell').forEach((el) => el.classList.toggle('sounding', Number(el.dataset.beat) === position.beat && Number(el.dataset.cell) === position.cell && !el.classList.contains('rest')));
    lastElapsed = position.elapsed;
    const barCount = Math.max(0, position.barIndex + 1);
    if (barCount !== lastBars) {
      lastBars = barCount;
      $('bar-counter').innerHTML = `${lastBars} <small>小节</small>`;
    }
    const seconds = Math.floor(lastElapsed);
    setText('session-time', `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`);
  }
  if (playing) frameId = requestAnimationFrame(animate);
}

async function togglePlayback() {
  if (starting) return;
  if (playing) { engine.stop(); return; }
  error('');
  lastBars = lastElapsed = 0;
  $('bar-counter').innerHTML = '0 <small>小节</small>';
  $('session-time').textContent = '00:00';
  starting = true;
  setPlaybackUI();
  try {
    playing = await engine.start();
  } catch (err) {
    error(err.message || '无法启动音频，请刷新后重试。');
  }
  starting = false;
  setPlaybackUI();
  if (playing) animate();
}

function tapTempo() {
  const now = performance.now();
  if (taps.length && now - taps.at(-1) > 3000) taps = [];
  taps.push(now);
  if (taps.length > 9) taps.shift();
  if (taps.length > 1) {
    const intervals = taps.slice(1).map((tap, i) => tap - taps[i]);
    const average = intervals.reduce((sum, interval) => sum + interval, 0) / intervals.length;
    update((s) => { s.bpm = Math.max(20, Math.min(300, Math.round(60000 / average))); });
  }
  $('tap-count').hidden = false;
  $('tap-count').textContent = `${taps.length}`;
  $('tap-button').setAttribute('aria-label', `测速，已点击 ${taps.length} 次，快捷键 T`);
  $('tap-button').classList.add('tapped');
  clearTimeout(tapTimeout);
  tapTimeout = setTimeout(() => {
    $('tap-button').classList.remove('tapped');
    $('tap-count').hidden = true;
    $('tap-button').setAttribute('aria-label', '测速，快捷键 T');
  }, 2500);
}

const soundIcons = {
  electronic: '<path d="M3 12h4l2-7 4 14 2-7h6"/>',
  wood: '<rect x="5" y="6" width="14" height="12" rx="2"/><path d="M9 6v12m6-12v12"/>',
  sticks: '<path d="m5 4 14 16M19 4 5 20"/>',
  cowbell: '<path d="m8 4-4 15h16L16 4ZM7 15h10m-7-11V2h4v2"/>',
  kick: '<circle cx="12" cy="11" r="8"/><circle cx="12" cy="11" r="5"/><path d="m6 18-2 4m14-4 2 4"/>',
  hihat: '<path d="M12 3v18M3 9h18M5 6h14M9 21l3-3 3 3"/>',
};

function initialize() {
  for (let beat = 1; beat <= 12; beat++) {
    const option = document.createElement('option'); option.value = beat; option.textContent = beat; $('beats').append(option);
  }
  for (const preset of PRESETS) {
    const button = document.createElement('button');
    button.type = 'button'; button.className = 'preset-button'; button.dataset.preset = preset.id;
    button.setAttribute('aria-label', preset.label);
    const notation = document.createElement('span'); notation.className = 'notation'; notation.innerHTML = presetNotation(preset.id); notation.setAttribute('aria-hidden', 'true');
    button.append(notation); button.addEventListener('click', () => selectPreset(preset.id)); $('preset-list').append(button);
  }
  for (const sound of SOUNDS) {
    const button = document.createElement('button'); button.type = 'button'; button.className = 'sound-button'; button.dataset.sound = sound.id;
    button.innerHTML = `<svg aria-hidden="true" viewBox="0 0 24 24">${soundIcons[sound.id]}</svg><span>${sound.label}</span>`;
    button.addEventListener('click', () => {
      update((s) => { s.sound = sound.id; });
      engine.setVolume(state.volume);
      if (!playing) engine.preview(sound.id).catch((err) => error(err.message));
    });
    $('sound-list').append(button);
    const option = document.createElement('option'); option.value = sound.id; option.textContent = sound.label; $('note-sound').append(option);
  }
  $('basic-mode').addEventListener('click', () => update((s) => { s.advanced = false; }));
  $('advanced-mode').addEventListener('click', () => update((s) => { s.advanced = true; }));
  $('play-button').addEventListener('click', togglePlayback);
  $('tap-button').addEventListener('click', tapTempo);
  $('tempo-minus').addEventListener('click', () => update((s) => { s.bpm = Math.max(20, (engine.getPosition()?.bpm ?? s.bpm) - 1); }));
  $('tempo-plus').addEventListener('click', () => update((s) => { s.bpm = Math.min(300, (engine.getPosition()?.bpm ?? s.bpm) + 1); }));
  for (const id of ['bpm', 'tempo-range']) $(id).addEventListener(id === 'bpm' ? 'change' : 'input', () => {
    if (id === 'bpm') {
      tempoEditing = false;
      if ($('bpm').value === '') { renderTempo(engine.getPosition()?.bpm ?? state.bpm); return; }
    }
    const value = Number($(id).value);
    if (Number.isFinite(value)) update((s) => { s.bpm = Math.max(20, Math.min(300, Math.round(value))); });
  });
  $('bpm').addEventListener('input', () => {
    tempoEditing = true;
    const value = Number($('bpm').value);
    if (Number.isFinite(value) && value >= 20 && value <= 300) update((s) => { s.bpm = Math.round(value); });
  });
  $('bpm').addEventListener('blur', () => {
    tempoEditing = false;
    renderTempo(engine.getPosition()?.bpm ?? state.bpm);
  });
  $('beats').addEventListener('change', () => {
    selected = null;
    update((s) => { s.beats = Number($('beats').value); if (s.preset !== 'custom') s.pattern = createPattern(s.beats, s.preset, s.swing); }, { editor: true });
  });
  $('accent').addEventListener('change', () => {
    const enabled = $('accent').checked;
    update((s) => {
      const first = getPattern(s)[0].cells[0];
      if (s.preset === 'custom' || (enabled && first.kind === 'rest')) {
        makeCustom();
        const cell = s.pattern[0].cells[0];
        if (enabled) cell.kind = 'accent';
        else if (cell.kind === 'accent') cell.kind = 'normal';
      }
      s.accent = enabled;
    }, { editor: true });
  });
  $('volume').addEventListener('input', () => {
    state.volume = Number($('volume').value) / 100;
    engine.setVolume(state.volume); save();
    $('volume-label').textContent = `${Math.round(state.volume * 100)}%`;
  });
  $('swing').addEventListener('input', () => update((s) => {
    s.swing = Number($('swing').value);
    if (s.preset !== 'custom') s.pattern = createPattern(s.beats, s.preset, s.swing);
  }, { editor: true }));
  $('paint-tools').addEventListener('click', (event) => {
    const button = event.target.closest('[data-tool]'); if (!button) return;
    paintTool = button.dataset.tool;
    document.querySelectorAll('[data-tool]').forEach((el) => {
      el.classList.toggle('selected', el === button); el.setAttribute('aria-pressed', el === button);
    });
  });
  $('beat-editor').addEventListener('click', (event) => {
    const button = event.target.closest('[data-cell], [data-swing-beat]'); if (!button) return;
    if (button.dataset.swingBeat !== undefined) {
      const index = Number(button.dataset.swingBeat);
      update(() => { makeCustom(); state.pattern[index].swing = !state.pattern[index].swing; }, { editor: true });
      document.querySelector(`[data-swing-beat="${index}"]`)?.focus({ preventScroll: true });
      return;
    }
    selected = { beat: Number(button.dataset.beat), cell: Number(button.dataset.cell) };
    update(() => {
      makeCustom();
      const cell = state.pattern[selected.beat].cells[selected.cell];
      cell.kind = paintTool === 'cycle' ? ({ normal: 'accent', accent: 'rest', rest: 'normal' })[cell.kind] : paintTool;
    }, { editor: true });
    document.querySelector(`[data-beat="${selected.beat}"][data-cell="${selected.cell}"]`)?.focus({ preventScroll: true });
  });
  $('beat-editor').addEventListener('change', (event) => {
    if (event.target.dataset.divisionBeat === undefined) return;
    const index = Number(event.target.dataset.divisionBeat);
    const count = Number(event.target.value);
    selected = null;
    update(() => { makeCustom(); state.pattern[index] = createBeat(count); }, { editor: true });
    document.querySelector(`[data-division-beat="${index}"]`)?.focus({ preventScroll: true });
  });
  for (const [id, key] of [['note-kind', 'kind'], ['note-velocity', 'velocity'], ['note-sound', 'sound']]) {
    $(id).addEventListener(id === 'note-velocity' ? 'input' : 'change', () => {
      if (!selected) return;
      update((s) => { s.pattern[selected.beat].cells[selected.cell][key] = key === 'velocity' ? Number($(id).value) : $(id).value; }, { editor: true });
    });
  }
  $('clear-pattern').addEventListener('click', () => update(() => {
    makeCustom(); state.pattern.forEach((beat) => beat.cells.forEach((cell) => { cell.kind = 'rest'; }));
  }, { editor: true }));
  $('restore-pattern').addEventListener('click', () => selectPreset('quarter'));
  $('preview-sound').addEventListener('click', () => { engine.setVolume(state.volume); engine.preview(state.sound, true).catch((err) => error(err.message)); });
  const practiceFields = { 'count-in': 'countIn', 'mute-enabled': 'muteEnabled', 'play-bars': 'playBars', 'mute-bars': 'muteBars', 'ramp-enabled': 'rampEnabled', 'ramp-every': 'rampEvery', 'ramp-step': 'rampStep', 'ramp-max': 'rampMax', 'stop-enabled': 'stopEnabled', 'stop-bars': 'stopBars' };
  for (const [id, key] of Object.entries(practiceFields)) {
    const input = $(id);
    input.addEventListener('change', () => update((s) => {
      s.practice[key] = input.type === 'checkbox' ? input.checked
        : Math.round(Math.max(Number(input.min), Math.min(Number(input.max), Number(input.value) || Number(input.min))));
    }));
    if (input.type === 'number') input.addEventListener('input', () => {
      const value = Number(input.value);
      if (input.value === '' || !Number.isInteger(value) || value < Number(input.min) || value > Number(input.max)) return;
      update((s) => { s.practice[key] = value; });
    });
  }
  $('export-button').addEventListener('click', () => {
    const blob = new Blob([serializeState(state)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a'); link.href = url; link.download = `节奏-${state.beats}-${state.denominator}-${state.bpm}bpm.json`;
    document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  $('import-button').addEventListener('click', () => $('import-file').click());
  $('import-file').addEventListener('change', async () => {
    const file = $('import-file').files[0]; if (!file) return;
    try {
      if (file.size > 262144) throw new Error('节奏文件不能超过 256 KB。');
      const imported = parseState(await file.text());
      state = imported; selected = null; taps = []; error('');
      if (playing) engine.refresh();
      const saved = save(); renderControls(); renderEditor(); renderRail(engine.getPosition() || compileBar(state, 0));
      engine.setVolume(state.volume);
      if (saved) { $('save-status').textContent = '节奏已导入并保存'; $('save-status').hidden = false; }
    } catch (err) { error(`导入失败：${err.message}`); }
    $('import-file').value = '';
  });
  document.addEventListener('keydown', (event) => {
    if (event.repeat || event.ctrlKey || event.metaKey || event.altKey || /INPUT|SELECT|TEXTAREA/.test(event.target.tagName) || event.target.isContentEditable) return;
    if (event.code === 'Space') {
      // Native button activation already handles Space while a button has focus.
      if (event.target.closest('button,a')) return;
      event.preventDefault(); togglePlayback();
    }
    if (event.code === 'KeyT') { event.preventDefault(); tapTempo(); }
  });
  window.addEventListener('pagehide', () => engine.stop());
  window.addEventListener('resize', () => renderRail(engine.getPosition() || compileBar(state, 0)));
  renderControls(); renderEditor(); renderRail(compileBar(state, 0));
}

initialize();
