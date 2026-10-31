'use strict';

// 轻量 WAV 解析：只取三段信息
//   1. duration      —— 音频总时长（用于播放看门狗）
//   2. speechStart   —— 首个有声帧（用于接话 preRoll，把静音前摇吃掉）
//   3. speechEnd     —— 最后一个有声帧（用于 replyAt，让下一只无缝接上）
// 原版 Windows 的 FastAudio 做的就是这件事，这里是等价实现。

const fs = require('fs');

function parseHeader(buf, file) {
  if (buf.length < 44) throw new Error('WAV 文件过短: ' + file);
  if (buf.toString('ascii', 0, 4) !== 'RIFF') throw new Error('不是 RIFF 文件: ' + file);
  if (buf.toString('ascii', 8, 12) !== 'WAVE') throw new Error('不是 WAVE 文件: ' + file);

  let off = 12;
  let fmt = null;
  let dataOff = -1;
  let dataLen = 0;

  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const len = buf.readUInt32LE(off + 4);
    const body = off + 8;

    if (id === 'fmt ' && len >= 16) {
      fmt = {
        encoding: buf.readUInt16LE(body),
        channels: buf.readUInt16LE(body + 2),
        sampleRate: buf.readUInt32LE(body + 4),
        byteRate: buf.readUInt32LE(body + 8),
        blockAlign: buf.readUInt16LE(body + 12),
        bits: buf.readUInt16LE(body + 14),
      };
    } else if (id === 'data') {
      dataOff = body;
      dataLen = Math.min(len, buf.length - body);
    }

    off = body + len + (len % 2);
  }

  if (!fmt || dataOff < 0 || !fmt.byteRate || !fmt.blockAlign) {
    throw new Error('WAV 缺少 fmt/data 块: ' + file);
  }
  if (![8, 16, 24, 32].includes(fmt.bits)) {
    throw new Error('不支持的位深 ' + fmt.bits + ': ' + file);
  }
  return { fmt, dataOff, dataLen };
}

function makeReader(buf, dataOff, fmt) {
  const { bits, blockAlign } = fmt;
  return function sampleAt(frame) {
    const o = dataOff + frame * blockAlign;
    switch (bits) {
      case 8:
        return (buf.readUInt8(o) - 128) * 256;
      case 16:
        return buf.readInt16LE(o);
      case 24:
        return Math.round(buf.readIntLE(o, 3) / 256);
      default:
        return Math.round(buf.readInt32LE(o) / 65536);
    }
  };
}

function detectSpeech(buf, dataOff, dataLen, fmt, duration) {
  const { sampleRate, blockAlign, channels } = fmt;
  const frames = Math.floor(dataLen / blockAlign);
  const fallback = { speechStart: 0, speechEnd: duration };
  if (frames <= 0 || !sampleRate) return fallback;

  const read = makeReader(buf, dataOff, fmt);
  const winFrames = Math.max(1, Math.round(sampleRate * 0.005)); // 5ms 一窗
  const windows = Math.ceil(frames / winFrames);
  const peaks = new Float64Array(windows);
  let globalPeak = 0;

  for (let w = 0; w < windows; w++) {
    const start = w * winFrames;
    const end = Math.min(frames, start + winFrames);
    let peak = 0;
    for (let f = start; f < end; f++) {
      // 多声道只检查第一声道，够用且更快
      const v = Math.abs(read(f));
      if (v > peak) peak = v;
    }
    peaks[w] = peak;
    if (peak > globalPeak) globalPeak = peak;
  }

  if (globalPeak <= 0) return fallback;

  const threshold = globalPeak * 0.03;
  let first = -1;
  let last = -1;
  for (let w = 0; w < windows; w++) {
    if (peaks[w] > threshold) {
      if (first < 0) first = w;
      last = w;
    }
  }
  if (first < 0) return fallback;

  const speechStart = Math.min(duration, (first * winFrames) / sampleRate);
  const speechEnd = Math.min(duration, ((last + 1) * winFrames) / sampleRate);

  return {
    speechStart: Number.isFinite(speechStart) ? Math.max(0, speechStart) : 0,
    speechEnd: Number.isFinite(speechEnd) ? Math.max(speechStart, speechEnd) : duration,
  };
}

function analyzeWav(file) {
  const buf = fs.readFileSync(file);
  const { fmt, dataOff, dataLen } = parseHeader(buf, file);
  const duration = dataLen / fmt.byteRate;
  const speech = detectSpeech(buf, dataOff, dataLen, fmt, duration);
  return {
    duration,
    speechStart: speech.speechStart,
    speechEnd: speech.speechEnd,
    sampleRate: fmt.sampleRate,
    channels: fmt.channels,
    bits: fmt.bits,
  };
}

module.exports = { analyzeWav };
