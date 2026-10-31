'use strict';

// 三个角色的静态配置。原版是三个独立 .exe，这里合并为一个进程、三个窗口，
// 角色键保持与 Windows 版一致（shaolan / sunpet / fengge），便于对照排查。

const ROLES = ['shaolan', 'sunpet', 'fengge'];

const ROLE_META = {
  shaolan: {
    key: 'shaolan',
    name: '邵艾伦',
    title: '邵艾伦桌宠',
    dir: 'shaolan',
    // 原版 start-trio.cmd：fengge 0 / sunpet 284 / shaolan 488，从屏幕右缘往左排
    cornerOffset: 488,
    intro: '点我说一句 · 右键设置',
  },
  sunpet: {
    key: 'sunpet',
    name: '太对了',
    title: '太对了桌宠',
    dir: 'sunpet',
    cornerOffset: 284,
    intro: '点我说一句 · 右键设置',
  },
  fengge: {
    key: 'fengge',
    name: '峰哥',
    title: '峰哥桌宠',
    dir: 'fengge',
    cornerOffset: 0,
    intro: '点我说一句 · 右键设置',
  },
};

// 太对了只从这几句里挑来接话（对应原版 SunPet 的 TakeReplyClip 固定池）
const SUNPET_REPLY_POOL = [1, 2, 4, 11, 13, 14];

module.exports = { ROLES, ROLE_META, SUNPET_REPLY_POOL };
