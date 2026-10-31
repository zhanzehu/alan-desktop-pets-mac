'use strict';

const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { analyzeWav } = require('./wav');
const { ROLES, ROLE_META } = require('./roles');

// 音频文件统一按 id 命名成 01.wav / 02.wav …
// 太对了的 clips.json 里写的是 .m4a，但仓库同时提供了转好的 PCM wav，
// 这里一律走 PCM，播放更稳、时长与 clips.json 也能对上。
function clipFileName(id) {
  return String(id).padStart(2, '0') + '.wav';
}

function pngSize(file) {
  const buf = fs.readFileSync(file);
  if (buf.length < 24 || buf.toString('ascii', 1, 4) !== 'PNG') return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

function loadRole(assetsDir, role) {
  const meta = ROLE_META[role];
  const dir = path.join(assetsDir, meta.dir);
  const clipsFile = path.join(dir, 'clips.json');

  if (!fs.existsSync(clipsFile)) throw new Error('缺少语音列表: ' + clipsFile);
  const raw = JSON.parse(fs.readFileSync(clipsFile, 'utf8'));
  if (!Array.isArray(raw) || raw.length === 0) throw new Error('语音列表为空: ' + clipsFile);

  const seen = new Set();
  const clips = [];

  for (const item of raw) {
    const id = Number(item && item.id);
    if (!Number.isInteger(id) || id <= 0 || seen.has(id)) continue;
    const label = String((item && item.label) || '').trim();
    if (!label) continue;

    const file = clipFileName(id);
    const abs = path.join(dir, 'Clips', file);
    if (!fs.existsSync(abs)) continue;

    let info;
    try {
      info = analyzeWav(abs);
    } catch (err) {
      info = { duration: Number(item.duration) || 0, speechStart: 0, speechEnd: Number(item.duration) || 0 };
    }
    if (!(info.duration > 0)) continue;

    seen.add(id);
    clips.push({
      id,
      label,
      file,
      path: abs,
      url: pathToFileURL(abs).href,
      duration: info.duration,
      speechStart: info.speechStart,
      speechEnd: info.speechEnd,
      answer: !!item.answer,
      defaultOff: !!item.defaultOff,
    });
  }

  if (clips.length === 0) throw new Error('没有可用语音: ' + dir);

  const facePath = path.join(dir, 'face.png');
  const size = pngSize(facePath);
  const imageRatio = size && size.width > 0 ? size.height / size.width : 1;

  return {
    role,
    name: meta.name,
    title: meta.title,
    cornerOffset: meta.cornerOffset,
    clips,
    imageUrl: pathToFileURL(facePath).href,
    imageRatio,
    facePath,
  };
}

function loadAll(assetsDir) {
  const catalog = {};
  for (const role of ROLES) catalog[role] = loadRole(assetsDir, role);
  return catalog;
}

module.exports = { loadAll, loadRole, clipFileName };
