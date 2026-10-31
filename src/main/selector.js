'use strict';

// PlaybackSelector 的等价移植：
//  - randomMode: 洗牌袋随机，不连续重复上一句
//  - pinnedId:   固定一句循环
//  - excludedIds: 轮播筛选；null = 从未保存过（用 clips.json 的 defaultOff），[] = 用户显式全开
// 这份状态逻辑与 UI/音频无关，因此可以直接单元测试。

class ShuffleBag {
  constructor(random = Math.random) {
    this.random = random;
    this.remaining = [];
    this.previous = -1;
    this.previousCount = -1;
  }

  next(count) {
    if (count <= 0) {
      this.remaining = [];
      this.previousCount = count;
      return -1;
    }
    if (this.previousCount !== count) this.remaining = [];
    this.previousCount = count;

    if (this.remaining.length === 0) {
      for (let i = 0; i < count; i++) this.remaining.push(i);
      for (let i = count - 1; i > 0; i--) {
        const j = Math.floor(this.random() * (i + 1));
        const t = this.remaining[i];
        this.remaining[i] = this.remaining[j];
        this.remaining[j] = t;
      }
      const last = this.remaining.length - 1;
      if (count > 1 && this.remaining[last] === this.previous) {
        const j = Math.floor(this.random() * last);
        const t = this.remaining[last];
        this.remaining[last] = this.remaining[j];
        this.remaining[j] = t;
      }
    }

    this.previous = this.remaining.pop();
    return this.previous;
  }

  reset() {
    this.remaining = [];
    this.previousCount = -1;
  }
}

class PlaybackSelector {
  constructor(clips, settings, random = Math.random) {
    if (!Array.isArray(clips) || clips.length === 0) throw new Error('语音列表不能为空');
    if (!settings) throw new Error('settings 不能为空');
    this.clips = clips.slice();
    this.settings = settings;
    this.random = random;
    this.byId = new Map();
    for (const clip of this.clips) this.byId.set(clip.id, clip);
    this.excluded = new Set();
    this.remaining = [];
    this.lastId = 0;
    this.validate();
  }

  defaultExclusions() {
    const set = new Set();
    for (const clip of this.clips) if (clip.defaultOff) set.add(clip.id);
    if (set.size === this.clips.length) set.delete(this.clips[0].id);
    return set;
  }

  validate() {
    let cleaned;
    if (!Array.isArray(this.settings.excludedIds)) {
      cleaned = this.defaultExclusions();
    } else {
      cleaned = new Set();
      for (const id of this.settings.excludedIds) {
        if (this.byId.has(id)) cleaned.add(id);
      }
    }
    // 配置损坏时绝不能让桌宠永久哑掉
    if (cleaned.size === this.clips.length) cleaned = this.defaultExclusions();

    const same = cleaned.size === this.excluded.size && [...cleaned].every((id) => this.excluded.has(id));
    if (!same) this.remaining = [];
    this.excluded = cleaned;

    this.settings.excludedIds = this.clips.filter((c) => cleaned.has(c.id)).map((c) => c.id);

    if (!this.byId.has(this.settings.pinnedId)) {
      this.settings.pinnedId = 0;
      if (!this.settings.randomMode) this.settings.randomMode = true;
    }
  }

  get allowedCount() {
    this.validate();
    return this.clips.length - this.excluded.size;
  }

  get pinnedClip() {
    this.validate();
    return this.byId.get(this.settings.pinnedId) || null;
  }

  isExcluded(id) {
    this.validate();
    return this.excluded.has(id);
  }

  recordPlayed(id) {
    if (this.byId.has(id)) this.lastId = id;
  }

  next() {
    this.validate();
    if (!this.settings.randomMode) {
      const clip = this.byId.get(this.settings.pinnedId);
      if (clip) {
        this.lastId = clip.id;
        return clip;
      }
      this.settings.randomMode = true;
    }
    return this.randomOnce();
  }

  randomOnce() {
    this.validate();
    if (this.remaining.length === 0) {
      this.remaining = this.clips.filter((c) => !this.excluded.has(c.id));
      for (let i = this.remaining.length - 1; i > 0; i--) {
        const j = Math.floor(this.random() * (i + 1));
        const t = this.remaining[i];
        this.remaining[i] = this.remaining[j];
        this.remaining[j] = t;
      }
      const last = this.remaining.length - 1;
      if (this.remaining.length > 1 && this.remaining[last].id === this.lastId) {
        const j = Math.floor(this.random() * last);
        const t = this.remaining[last];
        this.remaining[last] = this.remaining[j];
        this.remaining[j] = t;
      }
    }
    const clip = this.remaining.pop();
    this.lastId = clip.id;
    return clip;
  }

  choose(id) {
    this.validate();
    const clip = this.byId.get(id);
    if (!clip) return null;
    if (!this.settings.randomMode) this.settings.pinnedId = clip.id;
    this.lastId = clip.id;
    return clip;
  }

  setRandomMode(randomMode) {
    this.validate();
    if (!randomMode && this.settings.pinnedId === 0) {
      this.settings.pinnedId = this.byId.has(this.lastId) ? this.lastId : this.clips[0].id;
    }
    this.settings.randomMode = !!randomMode;
    this.remaining = [];
  }

  toggleExcluded(id) {
    this.validate();
    if (!this.byId.has(id)) return false;
    if (this.excluded.has(id)) {
      this.excluded.delete(id);
    } else {
      if (this.excluded.size === this.clips.length - 1) return false; // 至少留一句
      this.excluded.add(id);
    }
    this.settings.excludedIds = this.clips.filter((c) => this.excluded.has(c.id)).map((c) => c.id);
    this.remaining = [];
    return true;
  }

  enableAll() {
    this.settings.excludedIds = [];
    this.validate();
    this.remaining = [];
  }
}

module.exports = { PlaybackSelector, ShuffleBag };
