'use strict';

const { app, BrowserWindow, ipcMain, Menu, Tray, screen, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');

const { ROLES, ROLE_META, SUNPET_REPLY_POOL } = require('./roles');
const { loadAll } = require('./catalog');
const { PlaybackSelector, ShuffleBag } = require('./selector');
const { SettingsStore } = require('./settings');
const { shouldReply } = require('./bridge');

// 播放由 IPC 触发、不是页面里的用户手势，必须放开自动播放限制
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

let store = null;
let catalog = null;
let tray = null;
let filterWin = null;
let filterRole = null;
let drag = null;
let quitting = false;

const pets = Object.create(null); // role -> 运行时状态
const roleByWebContents = new Map();
const pendingReplies = Object.create(null); // role -> { timer, chainId, hop }

// ───────────────────────────── 资源与尺寸 ─────────────────────────────

function resolveAssetsDir() {
  if (app.isPackaged) {
    const packaged = path.join(process.resourcesPath, 'assets');
    if (fs.existsSync(path.join(packaged, 'shaolan'))) return packaged;
  }
  return path.join(__dirname, '..', '..', 'assets');
}

// 原版 ApplySize：Width = Size，Height = (Size - 16) * 图片比例 + 52
function windowSize(role, size) {
  const ratio = catalog[role].imageRatio;
  return {
    width: Math.round(size),
    height: Math.round((size - 16) * ratio + 52),
  };
}

function cornerPosition(role, width, height) {
  const area = screen.getPrimaryDisplay().workArea;
  const meta = ROLE_META[role];
  return {
    x: Math.round(area.x + area.width - width - 32 - meta.cornerOffset),
    y: Math.round(area.y + area.height - height - 24),
  };
}

// 拖到屏幕外也要能捞回来：只保证窗口有 80x80 落在某个显示器里
function clampIntoDisplays(x, y, width, height) {
  const displays = screen.getAllDisplays();
  const margin = 80;
  const visible = displays.some((d) => {
    const a = d.workArea;
    return (
      x + width > a.x + margin - width + Math.min(width, margin) &&
      x < a.x + a.width - margin + Math.min(width, margin) &&
      y + height > a.y &&
      y < a.y + a.height - margin + Math.min(height, margin)
    );
  });
  if (visible) return { x, y };

  const area = screen.getPrimaryDisplay().workArea;
  return {
    x: Math.min(Math.max(x, area.x - width + margin), area.x + area.width - margin),
    y: Math.min(Math.max(y, area.y), area.y + area.height - margin),
  };
}

function ensureVisible(role) {
  const p = pets[role];
  if (!p || !p.win || p.win.isDestroyed()) return;
  const b = p.win.getBounds();
  const pos = clampIntoDisplays(b.x, b.y, b.width, b.height);
  if (pos.x !== b.x || pos.y !== b.y) p.win.setPosition(pos.x, pos.y);
}

function moveToCorner(role) {
  const p = pets[role];
  if (!p || !p.win || p.win.isDestroyed()) return;
  const b = p.win.getBounds();
  const pos = cornerPosition(role, b.width, b.height);
  p.win.setPosition(pos.x, pos.y);
  ensureVisible(role);
}

// ───────────────────────────── 窗口 ─────────────────────────────

function createPetWindow(role) {
  const meta = ROLE_META[role];
  const s = store.pet(role);
  const { width, height } = windowSize(role, s.size);
  const pos = s.x !== null && s.y !== null
    ? clampIntoDisplays(s.x, s.y, width, height)
    : cornerPosition(role, width, height);

  const win = new BrowserWindow({
    width,
    height,
    x: pos.x,
    y: pos.y,
    title: meta.title,
    transparent: true,
    frame: false,
    hasShadow: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    backgroundColor: '#00000000',
    show: false,
    acceptFirstMouse: true,
    // 保留焦点能力：macOS 上 Menu.popup 需要窗口可激活，否则右键菜单不出现
    focusable: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
      spellcheck: false,
    },
  });

  win.setAlwaysOnTop(true, 'floating');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'pet.html'), { query: { role } });

  roleByWebContents.set(win.webContents.id, role);

  win.once('ready-to-show', () => {
    if (!win.isDestroyed()) win.showInactive();
  });

  win.webContents.on('did-finish-load', () => {
    if (win.isDestroyed()) return;
    // 透明窗口偶尔不触发 ready-to-show，这里兜一次底
    if (!win.isVisible()) win.showInactive();
    win.webContents.send('pet:caption', { text: meta.intro, seconds: 5 });
    win.webContents.send('pet:motion', { reduceMotion: store.pet(role).reduceMotion });
  });

  win.on('closed', () => {
    roleByWebContents.delete(win.webContents.id);
    if (pets[role]) {
      pets[role].win = null;
      pets[role].playing = false;
    }
  });

  return win;
}

// ───────────────────────────── 播放 ─────────────────────────────

function newChainId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function clearWatchdog(role) {
  const p = pets[role];
  if (!p) return;
  if (p.watchdog) {
    clearTimeout(p.watchdog);
    p.watchdog = null;
  }
}

function cancelPending(role) {
  const entry = pendingReplies[role];
  if (!entry) return;
  clearTimeout(entry.timer);
  delete pendingReplies[role];
}

function cancelAllPending() {
  for (const role of Object.keys(pendingReplies)) cancelPending(role);
}

// 同一条链被中断时，后面还没开口的那几只也要一起取消，
// 否则会出现"上一句已经停了，隔空又冒出一句"的错乱
function cancelChainReplies(chainId, hop) {
  if (!chainId) return;
  for (const role of Object.keys(pendingReplies)) {
    const entry = pendingReplies[role];
    if (entry.chainId === chainId && entry.hop >= hop) cancelPending(role);
  }
}

function sendCaption(role, text, seconds) {
  const p = pets[role];
  if (!p || !p.win || p.win.isDestroyed()) return;
  p.win.webContents.send('pet:caption', { text, seconds });
}

function playClip(role, clip, source) {
  const p = pets[role];
  if (!p || !p.win || p.win.isDestroyed() || !clip) return;

  cancelPending(role);
  clearWatchdog(role);

  const s = store.pet(role);
  const chainId = source ? source.chainId : newChainId();
  const hop = source ? source.hop + 1 : 0;
  const root = source ? source.root : role;

  // 提前 180ms 交接，让下一只的起音压在上一只尾音上，衔接才顺
  const replyAt = Math.max(clip.speechEnd, clip.duration - 0.18);

  p.playing = true;
  p.clipId = clip.id;
  p.chainId = chainId;
  p.hop = hop;
  p.startedAt = Date.now();
  p.selector.recordPlayed(clip.id);

  p.win.webContents.send('pet:play', {
    id: clip.id,
    label: clip.label,
    url: clip.url,
    volume: s.volume,
  });

  p.watchdog = setTimeout(() => {
    p.watchdog = null;
    stopRole(role, '这句暂时无法播放');
  }, Math.ceil((clip.duration + 5) * 1000));

  if (store.bridgeEnabled) {
    scheduleReplies({ from: role, chainId, hop, root, replyAt, startedAt: p.startedAt });
  }
}

function pickReplyClip(role) {
  const p = pets[role];
  const all = catalog[role].clips;
  if (!p || all.length === 0) return null;

  if (role === 'sunpet') {
    const pool = all.filter((c) => SUNPET_REPLY_POOL.includes(c.id) && !p.selector.isExcluded(c.id));
    if (pool.length === 0) return null;
    const signature = pool.map((c) => c.id).join(',');
    if (p.replySignature !== signature) {
      p.replyBag.reset();
      p.replySignature = signature;
    }
    const index = p.replyBag.next(pool.length);
    return index >= 0 ? pool[index] : null;
  }

  // 峰哥：全量洗牌，不连续重复
  const index = p.replyBag.next(all.length);
  return index >= 0 ? all[index] : null;
}

function scheduleReplies(msg) {
  for (const target of ROLES) {
    if (target === msg.from) continue;
    if (!shouldReply(target, msg)) continue;

    const p = pets[target];
    if (!p || !p.win || p.win.isDestroyed()) continue;
    // 只听"别的链"的忙音。同一条链里正在收尾是正常的——
    // 下一句本来就要压着上一句的尾音开口，不能因此判为忙碌而跳过。
    if (p.playing && p.chainId !== msg.chainId) continue;

    const elapsed = (Date.now() - msg.startedAt) / 1000;
    if (elapsed > msg.replyAt + 0.25) continue; // 已经太晚了，插进去会显得错乱

    const clip = pickReplyClip(target);
    if (!clip) continue;

    const preRoll = Math.min(0.16, clip.speechStart || 0);
    const delay = Math.max(1, Math.round((msg.replyAt - preRoll - 0.01 - elapsed) * 1000));

    cancelPending(target);
    pendingReplies[target] = {
      chainId: msg.chainId,
      hop: msg.hop,
      timer: setTimeout(() => {
        delete pendingReplies[target];
        const cur = pets[target];
        if (!cur || !cur.win || cur.win.isDestroyed()) return;
        if (cur.playing && cur.chainId !== msg.chainId) return;
        if (!store.bridgeEnabled) return;
        playClip(target, clip, msg);
      }, delay),
    };
  }
}

function stopRole(role, caption) {
  const p = pets[role];
  if (!p) return;
  const interruptedChain = p.chainId;
  const interruptedHop = p.hop;
  cancelPending(role);
  if (interruptedChain && interruptedHop >= 0) cancelChainReplies(interruptedChain, interruptedHop);
  clearWatchdog(role);
  if (p.win && !p.win.isDestroyed()) {
    p.win.webContents.send('pet:stop');
    if (caption) p.win.webContents.send('pet:caption', { text: caption, seconds: 4 });
  }
  p.playing = false;
  p.chainId = null;
  p.hop = -1;
}

function clickRole(role) {
  const p = pets[role];
  if (!p) return;
  // 用户主动点 = 新的对话，把没开口的旧接话全部作废
  cancelAllPending();
  const clip = p.selector.next();
  if (clip) playClip(role, clip, null);
  store.saveSoon();
}

// ───────────────────────────── 设置变更 ─────────────────────────────

function setVolume(role, value) {
  const p = pets[role];
  const s = store.pet(role);
  s.volume = Math.min(1, Math.max(0, value));
  if (p && p.win && !p.win.isDestroyed()) {
    p.win.webContents.send('pet:volume', { volume: s.volume });
  }
  store.save();
  refreshTray();
}

function setSize(role, value) {
  const p = pets[role];
  if (!p || !p.win || p.win.isDestroyed()) return;
  const s = store.pet(role);
  const b = p.win.getBounds();
  s.size = Math.min(400, Math.max(160, value));
  const { width, height } = windowSize(role, s.size);
  // 保持右下角锚点，缩放时人物不会跳走
  p.win.setBounds({ x: b.x + b.width - width, y: b.y + b.height - height, width, height });
  ensureVisible(role);
  store.save();
  refreshTray();
}

function setReduceMotion(role, value) {
  const p = pets[role];
  const s = store.pet(role);
  s.reduceMotion = !!value;
  if (p && p.win && !p.win.isDestroyed()) {
    p.win.webContents.send('pet:motion', { reduceMotion: s.reduceMotion });
  }
  store.save();
  refreshTray();
}

function toggleBridge() {
  store.bridgeEnabled = !store.bridgeEnabled;
  if (!store.bridgeEnabled) cancelAllPending();
  refreshTray();
  store.save();
}

function chooseClip(role, id) {
  const p = pets[role];
  if (!p) return;
  const clip = p.selector.choose(id);
  if (!clip) return;
  cancelAllPending();
  playClip(role, clip, null);
  store.save();
}

function setRandomMode(role, on) {
  const p = pets[role];
  if (!p) return;
  p.selector.setRandomMode(on);
  store.save();
}

function hideAll() {
  for (const role of ROLES) {
    const p = pets[role];
    if (p && p.win && !p.win.isDestroyed()) p.win.hide();
  }
  refreshTray();
}

function showAll() {
  for (const role of ROLES) {
    const p = pets[role];
    if (p && p.win && !p.win.isDestroyed()) {
      p.win.showInactive();
      p.win.setAlwaysOnTop(true, 'floating');
    }
  }
  refreshTray();
}

function allHidden() {
  return ROLES.every((role) => {
    const p = pets[role];
    return p && p.win && !p.win.isDestroyed() && !p.win.isVisible();
  });
}

function resetPositions() {
  for (const role of ROLES) {
    moveToCorner(role);
    const p = pets[role];
    if (p && p.win && !p.win.isDestroyed()) {
      const b = p.win.getBounds();
      store.setPosition(role, b.x, b.y);
    }
  }
}

// ───────────────────────────── 菜单 ─────────────────────────────

const VOLUMES = [0, 25, 50, 65, 80, 100];
const SIZES = [
  ['小', 190],
  ['中', 260],
  ['大', 340],
];

function linkStatusLabel() {
  if (!store.bridgeEnabled) return '联动：已关闭';
  return '联动：已开启 · 三宠同场';
}

function buildPetMenu(role) {
  const p = pets[role];
  const s = store.pet(role);
  const pet = catalog[role];
  const sel = p.selector;
  sel.validate();

  return Menu.buildFromTemplate([
    {
      label: '播放方式',
      submenu: [
        { label: '随机一句', type: 'radio', checked: s.randomMode, click: () => setRandomMode(role, true) },
        { label: '固定一句', type: 'radio', checked: !s.randomMode, click: () => setRandomMode(role, false) },
      ],
    },
    {
      label: '选择固定句',
      submenu: pet.clips.map((clip) => ({
        label: `${String(clip.id).padStart(2, '0')}  ${clip.label}`,
        type: 'radio',
        checked: !s.randomMode && s.pinnedId === clip.id,
        click: () => chooseClip(role, clip.id),
      })),
    },
    {
      label: `轮播内容（已选 ${sel.allowedCount} / ${pet.clips.length}）…`,
      click: () => openFilter(role),
    },
    {
      label: '随机播一次',
      click: () => {
        const clip = p.selector.randomOnce();
        if (!clip) return;
        cancelAllPending();
        playClip(role, clip, null);
      },
    },
    { label: '停止播放', click: () => stopRole(role, null) },
    { type: 'separator' },
    {
      label: store.bridgeEnabled ? '关闭桌宠联动' : '开启桌宠联动',
      type: 'checkbox',
      checked: store.bridgeEnabled,
      click: () => toggleBridge(),
    },
    { label: linkStatusLabel(), enabled: false },
    { type: 'separator' },
    {
      label: '音量',
      submenu: VOLUMES.map((percent) => ({
        label: percent === 0 ? '静音' : `${percent}%`,
        type: 'radio',
        checked: Math.abs(s.volume - percent / 100) < 0.01,
        click: () => setVolume(role, percent / 100),
      })),
    },
    {
      label: '人物大小',
      submenu: SIZES.map(([name, value]) => ({
        label: name,
        type: 'radio',
        checked: Math.abs(s.size - value) < 1,
        click: () => setSize(role, value),
      })),
    },
    {
      label: '减少动态效果',
      type: 'checkbox',
      checked: s.reduceMotion,
      click: () => setReduceMotion(role, !s.reduceMotion),
    },
    { label: '移回屏幕右下角', click: () => { moveToCorner(role); store.save(); } },
    { type: 'separator' },
    { label: '隐藏全部桌宠', click: () => hideAll() },
    { label: '退出桌宠', click: () => quitApp() },
  ]);
}

function buildTrayMenu() {
  const hidden = allHidden();
  const first = store.pet('shaolan');
  return Menu.buildFromTemplate([
    { label: hidden ? '显示全部桌宠' : '隐藏全部桌宠', click: () => (hidden ? showAll() : hideAll()) },
    { type: 'separator' },
    {
      label: store.bridgeEnabled ? '关闭桌宠联动' : '开启桌宠联动',
      type: 'checkbox',
      checked: store.bridgeEnabled,
      click: () => toggleBridge(),
    },
    {
      label: '音量（三只同步）',
      submenu: VOLUMES.map((percent) => ({
        label: percent === 0 ? '静音' : `${percent}%`,
        type: 'radio',
        checked: Math.abs(first.volume - percent / 100) < 0.01,
        click: () => { for (const role of ROLES) setVolume(role, percent / 100); refreshTray(); },
      })),
    },
    {
      label: '人物大小（三只同步）',
      submenu: SIZES.map(([name, value]) => ({
        label: name,
        type: 'radio',
        checked: Math.abs(first.size - value) < 1,
        click: () => { for (const role of ROLES) setSize(role, value); refreshTray(); },
      })),
    },
    {
      label: '减少动态效果（三只同步）',
      type: 'checkbox',
      checked: first.reduceMotion,
      click: () => { const next = !first.reduceMotion; for (const role of ROLES) setReduceMotion(role, next); refreshTray(); },
    },
    { label: '移回屏幕右下角', click: () => resetPositions() },
    { type: 'separator' },
    { label: '邵艾伦 · 轮播内容…', click: () => openFilter('shaolan') },
    { label: '太对了 · 轮播内容…', click: () => openFilter('sunpet') },
    { label: '峰哥 · 轮播内容…', click: () => openFilter('fengge') },
    { type: 'separator' },
    { label: '退出', click: () => quitApp() },
  ]);
}

// ───────────────────────────── 托盘 ─────────────────────────────

function trayIconPath() {
  const dir = path.join(__dirname, '..', '..', 'build');
  const at2x = path.join(dir, 'trayTemplate@2x.png');
  return fs.existsSync(at2x) ? path.join(dir, 'trayTemplate.png') : null;
}

function createTray() {
  const iconPath = trayIconPath();
  let image = iconPath ? nativeImage.createFromPath(iconPath) : null;
  if (image && !image.isEmpty()) {
    image.setTemplateImage(true);
  } else {
    image = nativeImage.createEmpty();
  }
  tray = new Tray(image);
  tray.setToolTip('Alan 桌宠');
  refreshTray();
}

function refreshTray() {
  if (!tray || tray.isDestroyed()) return;
  tray.setContextMenu(buildTrayMenu());
}

// ───────────────────────────── 筛选窗口 ─────────────────────────────

function openFilter(role) {
  if (filterWin && !filterWin.isDestroyed()) {
    if (filterRole === role) {
      filterWin.show();
      filterWin.focus();
      return;
    }
    // 换了另一只：关掉旧窗再开，避免标题和内容对不上
    filterWin.close();
    filterWin = null;
  }
  filterRole = role;
  filterWin = new BrowserWindow({
    width: 460,
    height: 660,
    title: `${catalog[role].name} · 轮播内容`,
    resizable: true,
    minimizable: false,
    maximizable: false,
    backgroundColor: '#1a1b1e',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'filter-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  filterWin.loadFile(path.join(__dirname, '..', 'renderer', 'filter.html'));
  filterWin.once('ready-to-show', () => filterWin.show());
  filterWin.on('closed', () => {
    filterWin = null;
    filterRole = null;
  });
}

// ───────────────────────────── IPC ─────────────────────────────

function roleOf(sender) {
  return roleByWebContents.get(sender.id) || null;
}

function registerIpc() {
  ipcMain.handle('pet:init', (event) => {
    const role = roleOf(event.sender);
    if (!role) return null;
    const pet = catalog[role];
    return {
      role,
      name: pet.name,
      imageUrl: pet.imageUrl,
      intro: ROLE_META[role].intro,
      reduceMotion: store.pet(role).reduceMotion,
      volume: store.pet(role).volume,
    };
  });

  ipcMain.on('pet:drag-start', (event) => {
    const role = roleOf(event.sender);
    const p = role && pets[role];
    if (!p || !p.win || p.win.isDestroyed()) return;

    const cursor = screen.getCursorScreenPoint();
    const [wx, wy] = p.win.getPosition();
    drag = {
      role,
      offsetX: cursor.x - wx,
      offsetY: cursor.y - wy,
      startX: cursor.x,
      startY: cursor.y,
      moved: false,
      timer: null,
    };

    // 用主进程轮询光标来移动窗口：即使指针甩出窗口、甚至甩出屏幕边缘，
    // 拖动也不会中断（比在渲染层监听 pointermove 更稳）
    drag.timer = setInterval(() => {
      if (!drag) return;
      const now = screen.getCursorScreenPoint();
      if (!drag.moved) {
        if (Math.abs(now.x - drag.startX) > 4 || Math.abs(now.y - drag.startY) > 4) drag.moved = true;
      }
      if (!drag.moved) return;
      const st = pets[drag.role];
      if (!st || !st.win || st.win.isDestroyed()) return;
      st.win.setPosition(now.x - drag.offsetX, now.y - drag.offsetY);
    }, 16);
  });

  ipcMain.on('pet:drag-end', (event) => {
    if (!drag) return;
    if (drag.timer) clearInterval(drag.timer);
    const { moved, role } = drag;
    drag = null;

    if (moved) {
      const p = pets[role];
      if (p && p.win && !p.win.isDestroyed()) {
        ensureVisible(role);
        const [x, y] = p.win.getPosition();
        store.setPosition(role, x, y);
      }
    } else {
      clickRole(role);
    }
  });

  ipcMain.on('pet:menu', (event) => {
    const role = roleOf(event.sender);
    if (!role) return;
    const p = pets[role];
    if (!p || !p.win || p.win.isDestroyed()) return;
    const menu = buildPetMenu(role);
    p.win.focus();
    menu.popup({ window: p.win });
  });

  ipcMain.on('pet:ended', (event, clipId) => {
    const role = roleOf(event.sender);
    if (!role) return;
    const p = pets[role];
    if (!p) return;
    clearWatchdog(role);
    if (p.clipId === clipId) {
      p.playing = false;
      p.chainId = null;
      p.hop = -1;
    }
  });

  ipcMain.on('pet:failed', (event, info) => {
    const role = roleOf(event.sender);
    if (!role) return;
    const p = pets[role];
    if (!p) return;
    clearWatchdog(role);
    p.playing = false;
    p.chainId = null;
    sendCaption(role, '这句暂时无法播放', 4);
  });

  // 筛选窗口
  ipcMain.handle('filter:load', () => {
    const role = filterRole;
    if (!role) return null;
    const p = pets[role];
    const s = store.pet(role);
    const sel = p.selector;
    sel.validate();
    return {
      role,
      name: catalog[role].name,
      randomMode: s.randomMode,
      pinnedId: s.pinnedId,
      allowedCount: sel.allowedCount,
      total: catalog[role].clips.length,
      clips: catalog[role].clips.map((c) => ({
        id: c.id,
        label: c.label,
        duration: c.duration,
        excluded: sel.isExcluded(c.id),
        answer: c.answer,
      })),
    };
  });

  ipcMain.handle('filter:toggle', (_event, id) => {
    if (!filterRole) return null;
    const p = pets[filterRole];
    p.selector.toggleExcluded(id);
    store.save();
    return p.selector.allowedCount;
  });

  ipcMain.handle('filter:restore-all', () => {
    if (!filterRole) return null;
    const p = pets[filterRole];
    p.selector.enableAll();
    store.save();
    return p.selector.allowedCount;
  });

  ipcMain.handle('filter:random-mode', (_event, on) => {
    if (!filterRole) return null;
    setRandomMode(filterRole, !!on);
    return true;
  });

  ipcMain.handle('filter:pin', (_event, id) => {
    if (!filterRole) return null;
    const p = pets[filterRole];
    p.selector.choose(id);
    store.save();
    return true;
  });

  ipcMain.handle('filter:preview', (_event, id) => {
    if (!filterRole) return null;
    const clip = catalog[filterRole].clips.find((c) => c.id === id);
    if (clip) {
      cancelAllPending();
      playClip(filterRole, clip, null);
    }
    return true;
  });

  ipcMain.on('filter:close', () => {
    if (filterWin && !filterWin.isDestroyed()) filterWin.close();
  });
}

// ───────────────────────────── 生命周期 ─────────────────────────────

function quitApp(code) {
  quitting = true;
  cancelAllPending();
  if (store) store.flush();
  for (const role of ROLES) {
    const p = pets[role];
    if (p && p.win && !p.win.isDestroyed()) p.win.destroy();
  }
  if (tray && !tray.isDestroyed()) tray.destroy();
  if (typeof code === 'number') app.exit(code);
  else app.quit();
}

function boot() {
  const assetsDir = resolveAssetsDir();

  try {
    catalog = loadAll(assetsDir);
  } catch (err) {
    const { dialog } = require('electron');
    dialog.showErrorBox('素材加载失败', String(err && err.message ? err.message : err));
    app.quit();
    return;
  }

  store = new SettingsStore(app.getPath('userData'));

  for (const role of ROLES) {
    pets[role] = {
      win: null,
      selector: new PlaybackSelector(catalog[role].clips, store.pet(role)),
      replyBag: new ShuffleBag(),
      replySignature: '',
      playing: false,
      clipId: 0,
      chainId: null,
      hop: -1,
      startedAt: 0,
      watchdog: null,
    };
  }

  // 保存位置 / 偏好的默认值统一交给 selector 归一化
  for (const role of ROLES) {
    pets[role].selector.validate();
    store.pet(role).pinnedId = pets[role].selector.settings.pinnedId;
    store.pet(role).randomMode = pets[role].selector.settings.randomMode;
  }
  store.save();

  registerIpc();
  Menu.setApplicationMenu(null);

  for (const role of ROLES) pets[role].win = createPetWindow(role);

  createTray();

  screen.on('display-metrics-changed', () => {
    for (const role of ROLES) ensureVisible(role);
  });
  screen.on('display-removed', () => {
    for (const role of ROLES) ensureVisible(role);
  });

  // 端到端验证（仅 PETS_E2E=1 时加载，正常使用不经过这里）
  if (process.env.PETS_E2E) {
    require('../../test/e2e-driver')({
      app,
      pets,
      catalog,
      click: clickRole,
      stop: stopRole,
      quit: quitApp,
      captureRoot: path.join(__dirname, '..', '..', '.cache'),
    });
  }
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    showAll();
  });

  app.whenReady().then(() => {
    // 纯菜单栏常驻应用：不占 Dock、不抢菜单栏
    if (app.dock) app.dock.hide();
    boot();
  });

  app.on('activate', () => {
    if (ROLES.every((role) => !pets[role] || !pets[role].win)) boot();
    else showAll();
  });

  app.on('window-all-closed', () => {
    // 菜单栏常驻应用：窗口全关也不退出（macOS 默认行为即如此，这里显式留空以表意图）
  });

  app.on('before-quit', () => {
    quitting = true;
    cancelAllPending();
    if (store) store.flush();
  });
}

module.exports = { __test: { windowSize, cornerPosition, clampIntoDisplays } };
