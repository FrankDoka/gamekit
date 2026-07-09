const state = {
  candidateDir: "",
  frames: [],
  currentIndex: 0,
  startIndex: null,
  endIndex: null,
  selectedOrder: [],
  selectMode: false,
  playing: false,
  rafId: null,
  lastPlaybackAt: 0,
  playbackRemainderMs: 0,
};

const el = {
  position: document.querySelector("#position"),
  candidatePath: document.querySelector("#candidatePath"),
  candidateInput: document.querySelector("#candidateInput"),
  browseCandidate: document.querySelector("#browseCandidate"),
  loadForm: document.querySelector("#loadForm"),
  importInput: document.querySelector("#importInput"),
  browseImport: document.querySelector("#browseImport"),
  importName: document.querySelector("#importName"),
  importForm: document.querySelector("#importForm"),
  toolStatus: document.querySelector("#toolStatus"),
  preview: document.querySelector("#preview"),
  play: document.querySelector("#play"),
  prev: document.querySelector("#prev"),
  next: document.querySelector("#next"),
  selectedOnly: document.querySelector("#selectedOnly"),
  skipSeam: document.querySelector("#skipSeam"),
  playbackFps: document.querySelector("#playbackFps"),
  scrubber: document.querySelector("#scrubber"),
  setStart: document.querySelector("#setStart"),
  setEnd: document.querySelector("#setEnd"),
  targetCount: document.querySelector("#targetCount"),
  distribute: document.querySelector("#distribute"),
  toggle: document.querySelector("#toggle"),
  clear: document.querySelector("#clear"),
  save: document.querySelector("#save"),
  currentName: document.querySelector("#currentName"),
  startName: document.querySelector("#startName"),
  endName: document.querySelector("#endName"),
  selectedSummary: document.querySelector("#selectedSummary"),
  saveStatus: document.querySelector("#saveStatus"),
  grid: document.querySelector("#grid"),
};

function frameUrl(index) {
  return `/frames/raw/${encodeURIComponent(state.frames[index])}`;
}

function frameLabel(index) {
  return state.frames[index] ?? "-";
}

function selectedSet() {
  return new Set(state.selectedOrder);
}

function clampIndex(index) {
  return Math.max(0, Math.min(state.frames.length - 1, index));
}

function setToolStatus(message, isError = false) {
  el.toolStatus.textContent = message;
  el.toolStatus.classList.toggle("is-error", isError);
}

function renderSelectMode() {
  el.toggle.textContent = state.selectMode ? "Select: ON" : "Select: OFF";
  el.toggle.classList.toggle("is-on", state.selectMode);
  el.toggle.setAttribute("aria-pressed", String(state.selectMode));
  el.grid.classList.toggle("is-select-mode", state.selectMode);
}

function setSelectMode(enabled) {
  state.selectMode = enabled;
  renderSelectMode();
}

function setCurrent(index, scroll = false) {
  if (state.frames.length === 0) return;
  state.currentIndex = clampIndex(index);
  render(!state.playing);
  if (scroll) {
    document.querySelector(`[data-index="${state.currentIndex}"]`)?.scrollIntoView({
      block: "nearest",
      inline: "nearest",
    });
  }
}

function fullSequence() {
  return state.frames.map((_, index) => index);
}

function activeSequence() {
  if (el.selectedOnly.checked && state.selectedOrder.length > 0) {
    return seamPreviewSequence(state.selectedOrder);
  }
  return fullSequence();
}

function seamPreviewSequence(sequence) {
  if (!el.skipSeam.checked || sequence.length < 3) return sequence;
  const start = state.startIndex ?? sequence[0];
  const end = state.endIndex ?? sequence[sequence.length - 1];
  if (sequence[0] !== start || sequence[sequence.length - 1] !== end) return sequence;
  return sequence.slice(0, -1);
}

function activeSequencePosition(sequence = activeSequence()) {
  const position = sequence.indexOf(state.currentIndex);
  return position === -1 ? 0 : position;
}

function syncScrubber(sequence = activeSequence()) {
  el.scrubber.max = String(Math.max(0, sequence.length - 1));
  el.scrubber.value = String(activeSequencePosition(sequence));
}

function jumpToActiveSequence() {
  const sequence = activeSequence();
  if (sequence.length === 0) return;
  if (sequence.includes(state.currentIndex)) {
    render();
    return;
  }
  setCurrent(sequence[0], true);
}

function nextPlaybackIndex() {
  const sequence = activeSequence();
  const position = sequence.indexOf(state.currentIndex);
  if (position === -1) return sequence[0] ?? 0;
  return sequence[(position + 1) % sequence.length];
}

function stepCurrent(delta) {
  const sequence = activeSequence();
  if (sequence.length === 0) return;
  const position = sequence.indexOf(state.currentIndex);
  const nextPosition = position === -1 ? 0 : Math.max(0, Math.min(sequence.length - 1, position + delta));
  setCurrent(sequence[nextPosition], true);
}

function stopPlayback() {
  state.playing = false;
  el.play.textContent = "Play";
  state.lastPlaybackAt = 0;
  state.playbackRemainderMs = 0;
  if (state.rafId) {
    window.cancelAnimationFrame(state.rafId);
    state.rafId = null;
  }
  render();
}

function startPlayback() {
  if (state.frames.length === 0) return;
  jumpToActiveSequence();
  state.playing = true;
  el.play.textContent = "Pause";
  state.rafId = window.requestAnimationFrame(playbackTick);
}

function playbackFrameMs() {
  const fps = Math.max(1, Math.min(30, Number(el.playbackFps.value) || 10));
  return 1000 / fps;
}

function playbackTick(timestamp) {
  if (!state.playing) return;
  if (state.lastPlaybackAt === 0) state.lastPlaybackAt = timestamp;
  const elapsedMs = timestamp - state.lastPlaybackAt + state.playbackRemainderMs;
  const frameMs = playbackFrameMs();
  if (elapsedMs >= frameMs) {
    const steps = Math.max(1, Math.floor(elapsedMs / frameMs));
    for (let step = 0; step < steps; step += 1) {
      setCurrent(nextPlaybackIndex(), false);
    }
    state.playbackRemainderMs = elapsedMs % frameMs;
    state.lastPlaybackAt = timestamp;
  }
  state.rafId = window.requestAnimationFrame(playbackTick);
}

function togglePlayback() {
  if (state.playing) stopPlayback();
  else startPlayback();
}

function toggleFrameSelection(index) {
  if (state.selectedOrder.includes(index)) {
    state.selectedOrder = state.selectedOrder.filter((value) => value !== index);
  } else {
    state.selectedOrder = [...state.selectedOrder, index].sort((a, b) => a - b);
  }
  if (state.currentIndex !== index) state.currentIndex = index;
  jumpToActiveSequence();
}

function toggleSelectMode() {
  setSelectMode(!state.selectMode);
}

function distribute() {
  if (state.startIndex === null || state.endIndex === null) return;
  const start = Math.min(state.startIndex, state.endIndex);
  const end = Math.max(state.startIndex, state.endIndex);
  const count = Math.max(1, Math.min(Number(el.targetCount.value) || 1, end - start + 1));
  if (count === 1) {
    state.selectedOrder = [Math.round((start + end) / 2)];
  } else {
    const picks = [];
    for (let i = 0; i < count; i += 1) {
      picks.push(Math.round(start + (i * (end - start)) / (count - 1)));
    }
    state.selectedOrder = [...new Set(picks)].sort((a, b) => a - b);
  }
  render();
}

function restoreSelection(selection) {
  if (!selection || typeof selection !== "object") return;
  if (Number.isInteger(selection.startIndex)) state.startIndex = selection.startIndex;
  if (Number.isInteger(selection.endIndex)) state.endIndex = selection.endIndex;
  if (Number.isInteger(selection.targetFrameCount)) {
    el.targetCount.value = String(selection.targetFrameCount);
  }
  if (Array.isArray(selection.selectedFrameIndices)) {
    state.selectedOrder = selection.selectedFrameIndices
      .filter((index) => Number.isInteger(index) && index >= 0 && index < state.frames.length)
      .sort((a, b) => a - b);
  }
}

function resetSelectionState() {
  stopPlayback();
  state.currentIndex = 0;
  state.startIndex = null;
  state.endIndex = null;
  state.selectedOrder = [];
  el.selectedOnly.checked = false;
  el.skipSeam.checked = true;
  setSelectMode(false);
  el.saveStatus.textContent = "";
}

function renderGrid() {
  const selected = selectedSet();
  el.grid.replaceChildren(
    ...state.frames.map((frame, index) => {
      const tile = document.createElement("button");
      tile.className = "tile";
      tile.dataset.index = String(index);
      tile.type = "button";
      tile.classList.toggle("is-viewing", index === state.currentIndex);
      tile.classList.toggle("is-start", index === state.startIndex);
      tile.classList.toggle("is-end", index === state.endIndex);
      tile.classList.toggle("is-selected", selected.has(index));
      tile.classList.toggle("can-select", state.selectMode);
      tile.addEventListener("click", () => {
        if (state.selectMode) {
          toggleFrameSelection(index);
          return;
        }
        setCurrent(index);
      });

      const label = document.createElement("span");
      label.textContent = frame.replace(/^frame-/, "f").replace(/\.(png|jpe?g|webp)$/i, "");

      const image = document.createElement("img");
      image.src = frameUrl(index);
      image.alt = frame;

      const badges = document.createElement("span");
      badges.className = "badges";
      if (index === state.currentIndex) badges.appendChild(badge("VIEW", "view"));
      if (index === state.startIndex) badges.appendChild(badge("START", "start"));
      if (index === state.endIndex) badges.appendChild(badge("END", "end"));
      if (selected.has(index)) badges.appendChild(badge(`SEL ${state.selectedOrder.indexOf(index) + 1}`, "sel"));
      if (!selected.has(index) && index !== state.startIndex && index !== state.endIndex) {
        badges.appendChild(badge("OFF", ""));
      }

      tile.append(label, image, badges);
      return tile;
    }),
  );
}

function badge(text, className) {
  const element = document.createElement("span");
  element.className = `badge ${className}`;
  element.textContent = text;
  return element;
}

function render(updateGrid = true) {
  if (state.frames.length === 0) {
    el.position.textContent = "0 / 0";
    el.preview.removeAttribute("src");
    el.currentName.textContent = "current -";
    el.startName.textContent = "start -";
    el.endName.textContent = "end -";
    el.selectedSummary.textContent = "0 selected";
    syncScrubber([]);
    if (updateGrid) el.grid.replaceChildren();
    return;
  }
  const sequence = activeSequence();
  const sequencePosition = activeSequencePosition(sequence);
  el.position.textContent = el.selectedOnly.checked && state.selectedOrder.length > 0
    ? `${sequencePosition + 1} / ${sequence.length} selected (${state.currentIndex + 1} / ${state.frames.length})`
    : `${state.currentIndex + 1} / ${state.frames.length}`;
  syncScrubber(sequence);
  el.preview.src = frameUrl(state.currentIndex);
  el.currentName.textContent = `current ${frameLabel(state.currentIndex)}`;
  el.startName.textContent = `start ${state.startIndex === null ? "-" : frameLabel(state.startIndex)}`;
  el.endName.textContent = `end ${state.endIndex === null ? "-" : frameLabel(state.endIndex)}`;
  const selectedNames = state.selectedOrder.map((index) => frameLabel(index));
  el.selectedSummary.textContent =
    selectedNames.length === 0 ? "0 selected" : `${selectedNames.length} selected: ${selectedNames.join(", ")}`;
  renderSelectMode();
  if (updateGrid) renderGrid();
}

async function postJson(url, payload) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const result = await response.json().catch(() => ({ error: response.statusText }));
  if (!response.ok) throw new Error(result.error ?? response.statusText);
  return result;
}

function applyCandidate(data, message) {
  resetSelectionState();
  state.candidateDir = data.candidateDir;
  state.frames = data.frames;
  el.candidatePath.textContent = state.candidateDir;
  el.candidateInput.value = state.candidateDir;
  syncScrubber(fullSequence());
  const run = data.candidateRun;
  if (run?.selectedFrameIndices?.length) {
    state.selectedOrder = run.selectedFrameIndices.filter(
      (index) => Number.isInteger(index) && index >= 0 && index < state.frames.length,
    );
    el.targetCount.value = String(run.targetFrames ?? state.selectedOrder.length);
  }
  restoreSelection(data.selection);
  setCurrent(0);
  setToolStatus(message ?? `loaded ${data.frameCount} frames`);
}

async function saveSelection() {
  const payload = {
    startIndex: state.startIndex,
    endIndex: state.endIndex,
    targetFrameCount: Number(el.targetCount.value) || state.selectedOrder.length,
    selectedFrameIndices: state.selectedOrder,
    selectedFrameNames: state.selectedOrder.map((index) => state.frames[index]),
    selectionMode: "frame-picker-manual",
    loop: true,
    notes: "",
  };
  const result = await postJson("/api/selection", payload);
  el.saveStatus.textContent = `saved ${result.selection.selectedFrameIndices.length} frames`;
}

async function loadCandidate() {
  const response = await fetch("/api/candidate");
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? `Failed to load candidate: ${response.statusText}`);
  applyCandidate(data, `loaded ${data.frameCount} frames`);
}

async function loadCandidateFromPath(candidateDir) {
  const data = await postJson("/api/candidate/load", { candidateDir });
  applyCandidate(data, `loaded ${data.frameCount} frames`);
}

async function browseFolder(input) {
  setToolStatus("choose a folder...");
  const result = await postJson("/api/browse-folder", {});
  if (result.canceled || !result.path) {
    setToolStatus("folder selection canceled");
    return "";
  }
  input.value = result.path;
  setToolStatus("folder selected");
  return result.path;
}

async function importFrames(sourceDir, targetName) {
  const data = await postJson("/api/import", { sourceDir, targetName });
  applyCandidate(data, `imported ${data.frameCount} frames`);
}

el.loadForm.addEventListener("submit", (event) => {
  event.preventDefault();
  void (async () => {
    let candidateDir = el.candidateInput.value.trim();
    if (!candidateDir) candidateDir = await browseFolder(el.candidateInput);
    if (!candidateDir) return;
    setToolStatus("loading...");
    await loadCandidateFromPath(candidateDir);
  })().catch((error) => setToolStatus(error.message, true));
});

el.importForm.addEventListener("submit", (event) => {
  event.preventDefault();
  void (async () => {
    let sourceDir = el.importInput.value.trim();
    if (!sourceDir) sourceDir = await browseFolder(el.importInput);
    if (!sourceDir) return;
    setToolStatus("importing...");
    await importFrames(sourceDir, el.importName.value.trim());
  })().catch((error) => setToolStatus(error.message, true));
});

el.browseCandidate.addEventListener("click", () => {
  browseFolder(el.candidateInput).catch((error) => setToolStatus(error.message, true));
});
el.browseImport.addEventListener("click", () => {
  browseFolder(el.importInput).catch((error) => setToolStatus(error.message, true));
});
el.play.addEventListener("click", togglePlayback);
el.prev.addEventListener("click", () => stepCurrent(-1));
el.next.addEventListener("click", () => stepCurrent(1));
el.selectedOnly.addEventListener("change", jumpToActiveSequence);
el.skipSeam.addEventListener("change", jumpToActiveSequence);
el.playbackFps.addEventListener("change", () => {
  state.lastPlaybackAt = 0;
  state.playbackRemainderMs = 0;
});
el.scrubber.addEventListener("input", () => {
  const sequence = activeSequence();
  setCurrent(sequence[Number(el.scrubber.value)] ?? 0, true);
});
el.setStart.addEventListener("click", () => {
  state.startIndex = state.currentIndex;
  render();
});
el.setEnd.addEventListener("click", () => {
  state.endIndex = state.currentIndex;
  render();
});
el.distribute.addEventListener("click", distribute);
el.toggle.addEventListener("click", toggleSelectMode);
el.clear.addEventListener("click", () => {
  state.selectedOrder = [];
  state.startIndex = null;
  state.endIndex = null;
  render();
});
el.save.addEventListener("click", () => {
  saveSelection().catch((error) => {
    el.saveStatus.textContent = `save failed: ${error.message}`;
  });
});

window.addEventListener("keydown", (event) => {
  if (event.key === "ArrowLeft") stepCurrent(-1);
  if (event.key === "ArrowRight") stepCurrent(1);
  if (event.key === " ") {
    event.preventDefault();
    togglePlayback();
  }
});

loadCandidate().catch((error) => {
  setToolStatus(error.message, true);
  render();
});
