'use strict';

// 接话规则——原版跨进程命名管道协议（DesktopPetLink.BridgeRules）的直接移植。
// 因为 macOS 版三个角色在同一个进程里，不再需要管道/事件/去重，
// 只保留「谁该接谁」这条链式状态机。
//
// 链路（root=起始角色，hop=第几跳）：
//   点邵艾伦: shaolan(0) → sunpet(1) → fengge(2) → sunpet(3) → 结束
//   点峰哥:   fengge(0)  → sunpet(1) → 结束
//   点太对了: sunpet(0)  → 只播自己

const MAX_HOP = 3;

// msg: { from, hop, root }
function shouldReply(targetRole, msg) {
  if (!msg || msg.hop < 0 || msg.hop >= MAX_HOP) return false;

  if (targetRole === 'sunpet') {
    return (
      (msg.from === 'shaolan' && msg.hop === 0 && msg.root === 'shaolan') ||
      (msg.from === 'fengge' && msg.hop === 0 && msg.root === 'fengge') ||
      (msg.from === 'fengge' && msg.hop === 2 && msg.root === 'shaolan')
    );
  }

  return targetRole === 'fengge' && msg.from === 'sunpet' && msg.hop === 1 && msg.root === 'shaolan';
}

// 给 UI 用的链路预览，方便自检和调试
function chainFor(startRole) {
  const chain = [{ from: startRole, hop: 0, root: startRole }];
  let msg = chain[0];
  while (msg.hop < MAX_HOP) {
    const next = ['shaolan', 'sunpet', 'fengge'].find((role) => role !== msg.from && shouldReply(role, msg));
    if (!next) break;
    msg = { from: next, hop: msg.hop + 1, root: msg.root };
    chain.push(msg);
  }
  return chain.map((step) => step.from);
}

module.exports = { shouldReply, chainFor, MAX_HOP };
