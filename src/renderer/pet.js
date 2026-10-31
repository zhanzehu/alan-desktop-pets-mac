'use strict';

const faceEl = document.getElementById('face');
const captionEl = document.getElementById('caption');
const captionTextEl = document.getElementById('captionText');

let audio = null;
let captionTimer = null;
let reduceMotion = false;
let playing = false;

// ── 字幕 ───────────────────────────────────────────────
function showCaption(text, seconds) {
  if (captionTimer) {
    clearTimeout(captionTimer);
    captionTimer = null;
  }
  const value = (text || '').trim();
  captionTextEl.textContent = value;
  captionEl.hidden = value.length === 0;

  if (value && seconds > 0) {
    captionTimer = setTimeout(() => {
      captionTimer = null;
      captionEl.hidden = true;
    }, seconds * 1000);
  }
}

// ── 动态效果 ───────────────────────────────────────────
function setSpeaking(on) {
  playing = !!on;
  document.body.classList.toggle('speaking', playing && !reduceMotion);
}

function applyMotion(flag) {
  reduceMotion = !!flag;
  document.body.classList.toggle('no-motion', reduceMotion);
  document.body.classList.toggle('speaking', playing && !reduceMotion);
}

// ── 音频 ───────────────────────────────────────────────
function teardownAudio() {
  if (!audio) return;
  const el = audio;
  audio = null;
  el.onended = null;
  el.onerror = null;
  try {
    el.pause();
  } catch (err) {
    /* 已停止 */
  }
  el.removeAttribute('src');
  try {
    el.load();
  } catch (err) {
    /* 忽略 */
  }
}

function play(data) {
  teardownAudio();

  const el = new Audio();
  el.preload = 'auto';
  el.volume = Math.min(1, Math.max(0, typeof data.volume === 'number' ? data.volume : 0.65));
  el.src = data.url;
  audio = el;

  setSpeaking(true);
  showCaption(data.label, 0);

  let settled = false;

  const finish = (ok) => {
    if (settled) return;
    settled = true;
    if (audio === el) audio = null;
    setSpeaking(false);
    if (ok) {
      showCaption(data.label, 0.4);
      window.pet.ended(data.id);
    } else {
      window.pet.failed(data.id, 'decode');
    }
  };

  el.onended = () => finish(true);
  el.onerror = () => finish(false);

  const started = el.play();
  if (started && typeof started.catch === 'function') {
    started.catch(() => finish(false));
  }
}

// ── 交互：拖动 / 点击 / 右键 ────────────────────────────
// 点击与拖动的判定放在主进程（位移 > 4px 算拖动），这里只负责转发
let pressing = false;

faceEl.addEventListener('pointerdown', (event) => {
  if (event.button !== 0) return;
  event.preventDefault();
  pressing = true;
  try {
    faceEl.setPointerCapture(event.pointerId);
  } catch (err) {
    /* 指针捕获不可用时不影响主流程 */
  }
  window.pet.dragStart();
});

function releasePointer(event) {
  if (!pressing) return;
  pressing = false;
  try {
    faceEl.releasePointerCapture(event.pointerId);
  } catch (err) {
    /* 忽略 */
  }
  window.pet.dragEnd();
}

window.addEventListener('pointerup', releasePointer);
window.addEventListener('pointercancel', releasePointer);
window.addEventListener('blur', () => {
  if (!pressing) return;
  pressing = false;
  window.pet.dragEnd();
});

window.addEventListener('contextmenu', (event) => {
  event.preventDefault();
  window.pet.showMenu();
});

// 禁用系统级拖拽与选中
window.addEventListener('dragstart', (event) => event.preventDefault());
window.addEventListener('selectstart', (event) => event.preventDefault());

// ── 主进程事件 ─────────────────────────────────────────
window.pet.onPlay(play);
window.pet.onStop(() => {
  teardownAudio();
  setSpeaking(false);
});
window.pet.onCaption((data) => {
  if (data) showCaption(data.text, data.seconds);
});
window.pet.onMotion((data) => {
  if (data) applyMotion(data.reduceMotion);
});
window.pet.onVolume((data) => {
  if (data && audio) audio.volume = Math.min(1, Math.max(0, data.volume));
});

// ── 启动 ───────────────────────────────────────────────
(async () => {
  const info = await window.pet.init();
  if (!info) return;

  applyMotion(info.reduceMotion);
  faceEl.src = info.imageUrl;
  faceEl.alt = info.name;
  faceEl.title = '点击说一句 · 拖动移动 · 右键设置';
  showCaption(info.intro, 5);
})().catch(() => {
  showCaption('素材加载失败', 6);
});
