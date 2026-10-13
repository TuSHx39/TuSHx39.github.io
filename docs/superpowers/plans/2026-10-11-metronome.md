# Metronome Implementation Plan

> **For agentic workers:** Use subagent-driven-development for independent engine work and native UI implementation. Track steps with checkboxes.

**Goal:** Add a polished, fully usable rhythm metronome to the existing static tool site.

**Architecture:** Pure rhythm model produces beat-relative events. An independent Web Audio scheduler consumes bar plans; the UI edits state and draws playback from audio time.

**Tech Stack:** Native HTML/CSS/JavaScript, Web Audio, Node built-in tests.

**Spec:** `docs/superpowers/specs/2026-10-11-metronome-design.md`

## Global Constraints

- No runtime dependencies; serve directly on GitHub Pages.
- Functional Chinese copy only, no slogans.
- BPM 20–300, 1–12 quarter-note beats per bar.
- Advanced features each optional; basic mode plays only base beats.
- Mobile and keyboard accessible.

## Review Focus

- Mixed triplet and straight beats retain exact positions.
- Switching to basic mode removes custom subdivisions from playback.
- Stopping cancels scheduled sound and animation state.
- Invalid imported settings cannot corrupt the active session.
- Live configuration changes activate immediately while preserving beat phase.

### Task 1: Rhythm model

Files: `pages/metronome/js/rhythm.js`, `pages/metronome/tests/rhythm.test.js`, `pages/metronome/package.json`.

Interfaces: `DEFAULT_STATE`, `PRESETS`, `SOUNDS`, `createBeat(divisions)`, `createPattern(beats,preset,swing)`, `compileBar(state,barIndex)`, `normalizeState(input)`, `serializeState(state)`, `parseState(text)`.

- [x] Write and run failing tests for timing, silence, import validation, practice behavior and basic mode.
- [x] Implement pure model and run all tests.

### Task 2: Audio transport

Files: `pages/metronome/js/audio.js`, audio tests.

Interface: `MetronomeEngine({getState,onBar,onStop,onError})`, `start()`, `stop()`, `setVolume(value)`, `preview(sound,accent)`, `getPosition()`.

- [x] Verify cancellation, next-bar state updates and clock behavior with test doubles for browser audio/time.
- [x] Implement sound synthesis and lookahead scheduling, then run tests.

### Task 3: Interface and integration

Files: `pages/metronome/index.html`, `pages/metronome/metronome.css`, `pages/metronome/js/app.js`, root `index.html`.

- [x] Build responsive basic controls, progress strip and advanced editor using model and engine interfaces.
- [x] Add presets, per-beat grid, note inspector, sounds, toggles, Tap tempo and validated local import/export.
- [x] Wire existing homepage entry.
- [x] Verify desktop/mobile UI, live playback, edits, persistence, errors and keyboard controls in browser.
- [x] Review all changes and rerun complete metronome tests.

## Verification results

- `npm test`: 43/43 passing (27 rhythm, 16 audio).
- All three JavaScript modules pass `node --check`; `git diff --check` clean.
- Homepage, tool HTML/CSS/JS and favicon return HTTP 200 from the local server.
- Browser verified custom mixed grids, note sounds/rests, persistence, valid import/export and invalid import errors.
- Narrow viewport: no document overflow; 16-cell grid scrolls within its row and preserves position after edits.
- Browser automatic stop completes; basic mode continues with advanced auto-stop configured.
- Independent review findings fixed: truthful persistence status and meter-aware preset labels.

## Local-file loading regression fix

- Replaced the module script entry with a generated classic script, `js/metronome.js`, so local file access does not request ES modules.
- Added dependency-free `npm run build` and freshness validation to `npm test`.
- 46/46 tests pass, including execution of the actual HTML script entry in a standalone VM with unavailable local storage.
- HTTP browser startup, tempo changes, count-in, audio-clock progress and stop were verified with no console errors.
- Browser automation blocks the file protocol; the local-file entry was therefore verified by standalone script execution tests, not by direct automated browser navigation.

## Immediate settings and Swiss UI revision

- [x] Add red regressions for live settings, primary ramp BPM, numeric input, Tap structure and interval-sensitive decay.
- [x] Recompile current and future audio schedules immediately, preserving fractional beat position and cancelling unsounded old voices.
- [x] Display actual ramp BPM without feeding animation values into the saved base tempo; apply numeric practice settings during input.
- [x] Restyle in Swiss black/white/blue grid, delete explanatory footnotes, and provide a stable graphic Tap button.
- [x] Rebuild the standalone browser bundle, pass the complete test suite, and verify desktop/mobile playback and interactions.

Revision verification: 66/66 tests pass (32 audio, 27 rhythm, 6 app runtime, 1 browser entry). Browser verified immediate preset edits during playback, actual ramp BPM synchronized with its slider, focused BPM ramping and unfinished-input recovery, Tap button/T shortcut, and 390px mobile layout with a 16-cell scrolling editor. No browser console warnings or errors. Decay extension is capped at 20 ms. The generated classic script still supports the standalone entry.

## Quarter-note beats and pale-blue revision

- [x] Fix every beat unit to a quarter note, migrate supported legacy units, and remove the denominator control.
- [x] Add a six-note subdivision preset, render 12 vector-notation buttons, and remove visible preset names.
- [x] Preserve the Swiss grid/type while adding coordinated pale-blue surfaces throughout the controls.
- [x] Rebuild the classic bundle; 73/73 tests pass. Desktop 4×3 and mobile 3×4 preset grids are full, SVG notes fit, and mobile page has no horizontal overflow. Browser console is clean.

## Bound first-cell accent revision

- [x] Use the custom first cell as the accent source; ordinary/rest cells no longer receive a hidden accent override.
- [x] Share getPattern between the editor and playback, bind the checkbox in both directions, and retain rests and later accents.
- [x] Change the custom preset glyph to three dots.
- [x] Rebuild the standalone bundle; 81/81 tests pass. Browser confirms checkbox→accent cell, cell→rest/ordinary with unchecked checkbox, three SVG dots, and no console errors.
