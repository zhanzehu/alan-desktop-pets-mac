'use strict';

const fs = require('fs');
const path = require('path');
const { ROLES } = require('./roles');

// 位置与偏好自动保存：userData/settings.json
// 写盘用「临时文件 + rename」，避免进程被杀时留下半个 JSON。

const DEFAULT_PET = () => ({
  volume: 0.65,
  size: 260,
  x: null,
  y: null,
  randomMode: true,
  pinnedId: 0,
  excludedIds: null, // null = 用 clips.json 的 defaultOff；[] = 用户显式全开
  reduceMotion: false,
});

const DEFAULTS = () => {
  const pets = {};
  for (const role of ROLES) pets[role] = DEFAULT_PET();
  return { version: 1, bridgeEnabled: true, pets };
};

function finite(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

function normalizePet(raw) {
  const base = DEFAULT_PET();
  if (!raw || typeof raw !== 'object') return base;

  base.volume = finite(raw.volume) ? Math.min(1, Math.max(0, raw.volume)) : 0.65;
  base.size = finite(raw.size) ? Math.min(400, Math.max(160, raw.size)) : 260;

  if (finite(raw.x) && finite(raw.y)) {
    base.x = Math.round(raw.x);
    base.y = Math.round(raw.y);
  }

  base.randomMode = typeof raw.randomMode === 'boolean' ? raw.randomMode : true;
  base.pinnedId = Number.isInteger(raw.pinnedId) && raw.pinnedId > 0 ? raw.pinnedId : 0;

  if (Array.isArray(raw.excludedIds)) {
    base.excludedIds = raw.excludedIds.filter((id) => Number.isInteger(id));
  } else {
    base.excludedIds = null;
  }

  base.reduceMotion = !!raw.reduceMotion;
  if (!base.randomMode && base.pinnedId === 0) base.randomMode = true;

  return base;
}

class SettingsStore {
  constructor(dir) {
    this.dir = dir;
    this.file = path.join(dir, 'settings.json');
    this.data = DEFAULTS();
    this.timer = null;
    this.load();
  }

  load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      const data = DEFAULTS();
      data.bridgeEnabled = typeof raw.bridgeEnabled === 'boolean' ? raw.bridgeEnabled : true;
      for (const role of ROLES) data.pets[role] = normalizePet(raw && raw.pets ? raw.pets[role] : null);
      this.data = data;
    } catch (err) {
      this.data = DEFAULTS();
    }
    return this.data;
  }

  get bridgeEnabled() {
    return this.data.bridgeEnabled;
  }

  set bridgeEnabled(on) {
    this.data.bridgeEnabled = !!on;
    this.save();
  }

  pet(role) {
    if (!this.data.pets[role]) this.data.pets[role] = DEFAULT_PET();
    return this.data.pets[role];
  }

  setPosition(role, x, y) {
    const pet = this.pet(role);
    pet.x = Math.round(x);
    pet.y = Math.round(y);
    this.save();
  }

  // 拖动时每帧都写盘没有意义，150ms 合并一次
  saveSoon() {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.save();
    }, 150);
  }

  save() {
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      const tmp = path.join(this.dir, '.settings-' + process.pid + '.tmp');
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8');
      fs.renameSync(tmp, this.file);
    } catch (err) {
      // 保存失败不该让桌宠崩掉，静默降级
    }
  }

  flush() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.save();
  }
}

module.exports = { SettingsStore, DEFAULT_PET, DEFAULTS };
