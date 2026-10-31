'use strict';

const listEl = document.getElementById('list');
const countEl = document.getElementById('count');
const titleEl = document.getElementById('title');
const modeRandomEl = document.getElementById('modeRandom');
const modePinnedEl = document.getElementById('modePinned');
const restoreEl = document.getElementById('restore');
const doneEl = document.getElementById('done');

let state = null;

function fmtDuration(seconds) {
  return (Number(seconds) || 0).toFixed(1) + 's';
}

function paintModes() {
  const random = !!state.randomMode;
  modeRandomEl.setAttribute('aria-pressed', String(random));
  modePinnedEl.setAttribute('aria-pressed', String(!random));
}

function paintCount() {
  countEl.textContent = `已选 ${state.allowedCount} / ${state.total}`;
}

function rowFor(clip) {
  const row = document.createElement('div');
  row.className = 'row' + (clip.excluded ? ' off' : '');

  const box = document.createElement('input');
  box.type = 'checkbox';
  box.checked = !clip.excluded;
  box.addEventListener('change', async () => {
    const allowed = await window.filter.toggle(clip.id);
    if (allowed === null) return;
    clip.excluded = !box.checked;
    row.className = 'row' + (clip.excluded ? ' off' : '');
    state.allowedCount = allowed;
    paintCount();
  });

  const idx = document.createElement('span');
  idx.className = 'idx';
  idx.textContent = String(clip.id).padStart(2, '0');

  const label = document.createElement('span');
  label.className = 'label';
  label.textContent = clip.label;
  label.title = clip.label;

  row.append(box, idx, label);

  if (clip.answer) {
    const tag = document.createElement('span');
    tag.className = 'tag';
    tag.textContent = '接话';
    row.append(tag);
  }

  const dur = document.createElement('span');
  dur.className = 'dur';
  dur.textContent = fmtDuration(clip.duration);

  const preview = document.createElement('button');
  preview.className = 'preview';
  preview.type = 'button';
  preview.textContent = '▶';
  preview.title = '试听这句';
  preview.addEventListener('click', async (event) => {
    event.stopPropagation();
    await window.filter.preview(clip.id);
  });

  row.append(dur, preview);
  return row;
}

function render() {
  titleEl.textContent = `${state.name} · 轮播内容`;
  paintModes();
  paintCount();
  listEl.replaceChildren(...state.clips.map(rowFor));
}

async function refresh() {
  const next = await window.filter.load();
  if (!next) return;
  state = next;
  render();
}

modeRandomEl.addEventListener('click', async () => {
  state.randomMode = true;
  paintModes();
  await window.filter.setRandomMode(true);
});

modePinnedEl.addEventListener('click', async () => {
  state.randomMode = false;
  paintModes();
  await window.filter.setRandomMode(false);
});

restoreEl.addEventListener('click', async () => {
  const allowed = await window.filter.restoreAll();
  if (allowed === null) return;
  await refresh();
});

doneEl.addEventListener('click', () => window.filter.close());

window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') window.filter.close();
});

refresh().catch(() => {
  titleEl.textContent = '轮播内容';
  countEl.textContent = '加载失败';
});
