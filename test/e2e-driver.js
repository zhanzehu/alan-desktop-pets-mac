'use strict';

// 端到端验证驱动：只在 PETS_E2E=1 时被 main.js 惰性加载，生产路径完全不经过。
// 做的事：
//   1. 等三个窗口加载完，检查头像真的解码出来了
//   2. 逐窗口 capturePage 截图（绕开系统录屏权限）
//   3. 模拟点击邵艾伦，按 60ms 采样 6 秒，还原「谁在说话」的时间线
//   4. 断言接话顺序 = 邵艾伦 → 太对了 → 峰哥 → 太对了
//   5. 写 e2e.json 并退出

const fs = require('fs');
const path = require('path');
const { ROLES } = require('../src/main/roles');

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

module.exports = function runE2E(ctx) {
  const { app, pets, catalog, click, captureRoot } = ctx;
  const results = [];
  const record = (ok, name, detail) => results.push({ ok, name, detail: detail === undefined ? null : detail });
  const fail = (name, detail) => record(false, name, detail);

  async function probe(role) {
    const p = pets[role];
    if (!p || !p.win || p.win.isDestroyed()) return null;
    try {
      return await p.win.webContents.executeJavaScript(`(() => {
        const face = document.getElementById('face');
        const cap = document.getElementById('caption');
        const txt = document.getElementById('captionText');
        return {
          faceLoaded: !!(face && face.complete && face.naturalWidth > 0),
          faceSize: face ? [face.naturalWidth, face.naturalHeight] : null,
          caption: cap && !cap.hidden && txt ? txt.textContent : null,
          speaking: document.body.classList.contains('speaking'),
          viewport: [window.innerWidth, window.innerHeight],
          scroll: [document.documentElement.scrollWidth, document.documentElement.scrollHeight]
        };
      })()`);
    } catch (err) {
      return null;
    }
  }

  async function capture(role) {
    const p = pets[role];
    if (!p || !p.win || p.win.isDestroyed()) return null;
    const image = await p.win.capturePage();
    const file = path.join(captureRoot, `cap-${role}.png`);
    fs.writeFileSync(file, image.toPNG());
    return file;
  }

  async function main() {
    fs.mkdirSync(captureRoot, { recursive: true });

    // 1. 等加载
    for (let i = 0; i < 40; i++) {
      const ready = await Promise.all(ROLES.map(probe));
      if (ready.every((r) => r && r.faceLoaded)) break;
      await wait(150);
    }

    for (const role of ROLES) {
      const info = await probe(role);
      if (!info) {
        fail(`${role} 窗口可访问`, 'probe 返回 null');
        continue;
      }
      record(info.faceLoaded, `${role} 头像已解码`, info.faceSize);
      record(!!info.caption, `${role} 开场字幕可见`, info.caption);

      const file = await capture(role);
      record(!!file, `${role} 截图已生成`, file);

      // 视口不应产生滚动条，否则说明布局溢出
      record(
        info.scroll[0] <= info.viewport[0] + 1 && info.scroll[1] <= info.viewport[1] + 1,
        `${role} 内容不溢出窗口`,
        { viewport: info.viewport, scroll: info.scroll }
      );
    }

    // 2. 点邵艾伦，采样时间线
    const expected = 'shaolan,sunpet,fengge,sunpet';
    await click('shaolan');

    const timeline = [];
    const startedOrder = [];
    const lastState = Object.fromEntries(ROLES.map((r) => [r, false]));

    for (let elapsed = 0; elapsed < 8000; elapsed += 60) {
      const snapshot = { t: elapsed, speaking: {}, caption: {} };
      for (const role of ROLES) {
        const info = await probe(role);
        const speaking = !!(info && info.speaking);
        snapshot.speaking[role] = speaking;
        snapshot.caption[role] = info ? info.caption : null;
        if (speaking && !lastState[role]) {
          startedOrder.push(role);
          if (startedOrder.length === 1) await capture(role).catch(() => {});
        }
        lastState[role] = speaking;
      }
      timeline.push(snapshot);

      if (startedOrder.length >= 4) {
        // 等第四句播完再收尾
        await wait(1200);
        break;
      }
      await wait(60);
    }

    const observed = startedOrder.join(',');
    record(observed === expected, '接话顺序 邵艾伦→太对了→峰哥→太对了', observed);

    record(
      startedOrder.length === 4,
      '链路在第四句后结束（不会无限接）',
      `实际开口 ${startedOrder.length} 次`
    );

    // 3. 点太对了不应触发任何接话
    await wait(600);
    const before = startedOrder.length;
    await click('sunpet');
    let extraReplies = 0;
    for (let elapsed = 0; elapsed < 2500; elapsed += 80) {
      for (const role of ROLES) {
        if (role === 'sunpet') continue;
        const info = await probe(role);
        if (info && info.speaking) extraReplies++;
      }
      await wait(80);
    }
    record(extraReplies === 0, '点太对了只播自己，不引发接话', `其他角色发声采样 ${extraReplies} 次`);

    // 4. 停止播放能中断未开口的接话
    await click('shaolan');
    await wait(120);
    ctx.stop('shaolan', null);
    let strayAfterStop = 0;
    for (let elapsed = 0; elapsed < 2500; elapsed += 80) {
      for (const role of ['sunpet', 'fengge']) {
        const info = await probe(role);
        if (info && info.speaking) strayAfterStop++;
      }
      await wait(80);
    }
    record(strayAfterStop === 0, '中途停止播放后不再冒出接话', `残留发声采样 ${strayAfterStop} 次`);

    // 5. 设置读写
    const file = path.join(app.getPath('userData'), 'settings.json');
    record(fs.existsSync(file), '偏好文件已落盘', file);

    const failed = results.filter((r) => !r.ok).length;
    const report = { passed: results.length - failed, failed, results, timeline };
    fs.writeFileSync(path.join(captureRoot, 'e2e.json'), JSON.stringify(report, null, 2), 'utf8');

    for (const r of results) {
      console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? '  ' + JSON.stringify(r.detail) : ''}`);
    }
    console.log(`\nE2E: ${report.passed} 通过 / ${failed} 失败`);

    ctx.quit(failed === 0 ? 0 : 1);
  }

  main().catch((err) => {
    console.log('E2E 异常: ' + (err && err.stack ? err.stack : err));
    ctx.quit(1);
  });
};
