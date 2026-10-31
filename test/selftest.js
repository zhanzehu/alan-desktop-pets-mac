'use strict';

// 无 Electron 依赖的自检：素材、时长、筛选状态机、接话链路。
// 运行：node test/selftest.js

const path = require('path');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const { loadAll } = require(path.join(ROOT, 'src/main/catalog'));
const { PlaybackSelector, ShuffleBag } = require(path.join(ROOT, 'src/main/selector'));
const { shouldReply, chainFor } = require(path.join(ROOT, 'src/main/bridge'));
const { ROLES, SUNPET_REPLY_POOL } = require(path.join(ROOT, 'src/main/roles'));

let passed = 0;
function check(name, fn) {
  try {
    fn();
    passed++;
    console.log('  ✓ ' + name);
  } catch (err) {
    console.error('  ✗ ' + name);
    console.error('    ' + (err && err.message));
    process.exitCode = 1;
  }
}

console.log('\n[1] 素材与音频');
const catalog = loadAll(path.join(ROOT, 'assets'));

check('三个角色全部加载', () => {
  assert.deepStrictEqual(Object.keys(catalog).sort(), [...ROLES].sort());
});

check('语音数量与原版一致（37 / 28 / 11）', () => {
  assert.strictEqual(catalog.shaolan.clips.length, 37);
  assert.strictEqual(catalog.sunpet.clips.length, 28);
  assert.strictEqual(catalog.fengge.clips.length, 11);
});

check('每条语音都有正数时长与可读字幕', () => {
  for (const role of ROLES) {
    for (const clip of catalog[role].clips) {
      assert.ok(clip.duration > 0.1 && clip.duration < 30, `${role}#${clip.id} 时长异常`);
      assert.ok(clip.label.length > 0, `${role}#${clip.id} 字幕为空`);
      assert.ok(clip.url.startsWith('file://'), `${role}#${clip.id} url 异常`);
    }
  }
});

check('人声边界在时长范围内，且能算出交接口', () => {
  for (const role of ROLES) {
    for (const clip of catalog[role].clips) {
      assert.ok(clip.speechStart >= 0 && clip.speechStart <= clip.duration, `${role}#${clip.id} speechStart`);
      assert.ok(clip.speechEnd > clip.speechStart && clip.speechEnd <= clip.duration + 1e-6, `${role}#${clip.id} speechEnd`);
      const replyAt = Math.max(clip.speechEnd, clip.duration - 0.18);
      assert.ok(replyAt > 0 && replyAt <= clip.duration + 1e-6, `${role}#${clip.id} replyAt`);
    }
  }
});

check('图片比例合理（0.5 ~ 2）', () => {
  for (const role of ROLES) {
    const r = catalog[role].imageRatio;
    assert.ok(r > 0.5 && r < 2, `${role} ratio=${r}`);
  }
});

console.log('\n[2] 接话链路');
check('点邵艾伦 → 邵艾伦/太对了/峰哥/太对了 四句', () => {
  assert.deepStrictEqual(chainFor('shaolan'), ['shaolan', 'sunpet', 'fengge', 'sunpet']);
});

check('点峰哥 → 峰哥/太对了 两句', () => {
  assert.deepStrictEqual(chainFor('fengge'), ['fengge', 'sunpet']);
});

check('点太对了 → 只播自己', () => {
  assert.deepStrictEqual(chainFor('sunpet'), ['sunpet']);
});

check('链路超过第 3 跳必须停', () => {
  assert.strictEqual(shouldReply('sunpet', { from: 'fengge', hop: 3, root: 'shaolan' }), false);
  assert.strictEqual(shouldReply('fengge', { from: 'sunpet', hop: 3, root: 'shaolan' }), false);
});

check('邵艾伦自己永远不接话', () => {
  for (const from of ROLES) {
    for (let hop = 0; hop <= 3; hop++) {
      assert.strictEqual(shouldReply('shaolan', { from, hop, root: 'shaolan' }), false);
    }
  }
});

check('root=fengge 的链路不会绕回峰哥', () => {
  assert.strictEqual(shouldReply('fengge', { from: 'sunpet', hop: 1, root: 'fengge' }), false);
});

console.log('\n[3] 播放选择器');
check('邵艾伦默认启用 8 句（29 句 defaultOff）', () => {
  const s = { volume: 0.65, size: 260, randomMode: true, pinnedId: 0, excludedIds: null };
  const sel = new PlaybackSelector(catalog.shaolan.clips, s);
  assert.strictEqual(sel.allowedCount, 8);
});

check('随机模式不连续重复同一句', () => {
  const s = { volume: 0.65, size: 260, randomMode: true, pinnedId: 0, excludedIds: null };
  const sel = new PlaybackSelector(catalog.sunpet.clips, s);
  let previous = null;
  let repeats = 0;
  for (let i = 0; i < 300; i++) {
    const clip = sel.next();
    if (previous !== null && clip.id === previous) repeats++;
    previous = clip.id;
  }
  assert.strictEqual(repeats, 0, `出现 ${repeats} 次连续重复`);
});

check('洗牌袋一轮内覆盖全部可选句', () => {
  const s = { volume: 0.65, size: 260, randomMode: true, pinnedId: 0, excludedIds: [] };
  const sel = new PlaybackSelector(catalog.fengge.clips, s);
  const seen = new Set();
  for (let i = 0; i < catalog.fengge.clips.length; i++) seen.add(sel.next().id);
  assert.strictEqual(seen.size, catalog.fengge.clips.length);
});

check('固定模式始终返回同一句', () => {
  const s = { volume: 0.65, size: 260, randomMode: false, pinnedId: 7, excludedIds: [] };
  const sel = new PlaybackSelector(catalog.shaolan.clips, s);
  for (let i = 0; i < 5; i++) assert.strictEqual(sel.next().id, 7);
});

check('至少保留一句：不能把最后一句也关掉', () => {
  const s = { volume: 0.65, size: 260, randomMode: true, pinnedId: 0, excludedIds: [] };
  const sel = new PlaybackSelector(catalog.fengge.clips, s);
  const total = catalog.fengge.clips.length;
  for (let i = 0; i < total; i++) sel.toggleExcluded(catalog.fengge.clips[i].id);
  assert.strictEqual(sel.allowedCount, 1);
});

check('配置全被关掉时自动回落到默认启用集', () => {
  const all = catalog.sunpet.clips.map((c) => c.id);
  const s = { volume: 0.65, size: 260, randomMode: true, pinnedId: 0, excludedIds: all };
  const sel = new PlaybackSelector(catalog.sunpet.clips, s);
  assert.ok(sel.allowedCount >= 1);
});

check('enableAll 后全部可选', () => {
  const s = { volume: 0.65, size: 260, randomMode: true, pinnedId: 0, excludedIds: null };
  const sel = new PlaybackSelector(catalog.shaolan.clips, s);
  sel.enableAll();
  assert.strictEqual(sel.allowedCount, 37);
});

check('接话池内句子都存在且可选', () => {
  const ids = new Set(catalog.sunpet.clips.map((c) => c.id));
  for (const id of SUNPET_REPLY_POOL) assert.ok(ids.has(id), `太对了缺少接话句 #${id}`);
});

console.log('\n[4] 洗牌袋');
check('ShuffleBag 不连续重复', () => {
  const bag = new ShuffleBag();
  let prev = -1;
  for (let i = 0; i < 500; i++) {
    const v = bag.next(6);
    assert.notStrictEqual(v, prev);
    prev = v;
  }
});

console.log(`\n完成：${passed} 项通过${process.exitCode ? '，存在失败项' : ''}\n`);
