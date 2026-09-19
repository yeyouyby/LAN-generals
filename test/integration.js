'use strict';

/**
 * 联机集成测试：拉起真实服务端，走完
 * 建房 → 加入 → 加电脑 → 准备 → 开局 → 行军 → 聊天 → 投降 → 结算全流程。
 */

const { spawn } = require('child_process');
const path = require('path');
const http = require('http');
const WebSocket = require('ws');

const PORT = 4123;
const ROOT = path.join(__dirname, '..');
const T_MOUNTAIN = 1;
const T_GENERAL = 3;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function httpGet(pathname) {
  return new Promise((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port: PORT, path: pathname, timeout: 5000 }, (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode, body }));
      })
      .on('error', reject);
  });
}

class Client {
  constructor(name) {
    this.name = name;
    this.inbox = [];
    this.waiters = [];
  }
  async connect() {
    this.ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
    await new Promise((resolve, reject) => {
      this.ws.on('open', resolve);
      this.ws.on('error', reject);
    });
    this.ws.on('message', (data) => {
      let m;
      try {
        m = JSON.parse(data.toString());
      } catch (e) {
        return;
      }
      this.inbox.push(m);
      this.waiters = this.waiters.filter((w) => {
        if (w.pred(m)) {
          w.resolve(m);
          return false;
        }
        return true;
      });
    });
    this.send({ t: 'hello', name: this.name });
    const w = await this.waitFor((m) => m.t === 'welcome', 5000);
    this.id = w.clientId;
    return w;
  }
  send(o) {
    this.ws.send(JSON.stringify(o));
  }
  waitFor(pred, timeout = 8000) {
    const found = this.inbox.find(pred);
    if (found) return Promise.resolve(found);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w.resolve !== resolve);
        reject(new Error(`[${this.name}] 等待消息超时`));
      }, timeout);
      this.waiters.push({
        pred,
        resolve: (m) => {
          clearTimeout(timer);
          resolve(m);
        },
      });
    });
  }
  lastTick() {
    const ticks = this.inbox.filter((m) => m.t === 'tick');
    return ticks[ticks.length - 1];
  }
  close() {
    try {
      this.ws.close();
    } catch (e) {
      /* ignore */
    }
  }
}

async function main() {
  const server = spawn('node', ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverLog = '';
  server.stdout.on('data', (c) => (serverLog += c));
  server.stderr.on('data', (c) => (serverLog += c));

  const kill = () => {
    try {
      server.kill('SIGKILL');
    } catch (e) {
      /* ignore */
    }
  };
  process.on('exit', kill);

  try {
    // 等服务就绪
    let ready = false;
    for (let i = 0; i < 50; i++) {
      try {
        const r = await httpGet('/');
        if (r.status === 200 && r.body.includes('LAN-generals')) {
          ready = true;
          break;
        }
      } catch (e) {
        /* retry */
      }
      await sleep(200);
    }
    if (!ready) throw new Error('服务端未能启动：\n' + serverLog);
    console.log('✓ 服务端启动，首页可访问');

    const A = new Client('测试甲');
    const B = new Client('测试乙');
    await A.connect();
    await B.connect();
    console.log('✓ 双客户端连接成功');

    // 建房
    A.send({ t: 'createRoom', roomName: '集成测试房', maxPlayers: 4, mapSize: 'small', speed: 'fast' });
    const roomMsg = await A.waitFor((m) => m.t === 'room' && m.room.players.length === 1);
    const roomId = roomMsg.room.id;
    console.log('✓ 建房成功');

    // B 加入
    B.send({ t: 'joinRoom', roomId });
    await B.waitFor((m) => m.t === 'room' && m.room.players.length === 2);
    console.log('✓ 加入房间成功');

    // 房主加电脑
    A.send({ t: 'addBot' });
    await A.waitFor((m) => m.t === 'room' && m.room.players.length === 3);
    console.log('✓ 添加电脑成功');

    // 聊天
    A.send({ t: 'chat', text: '你好乙' });
    await B.waitFor((m) => m.t === 'chat' && m.from === '测试甲' && m.text === '你好乙');
    console.log('✓ 聊天互通');

    // 准备并开局
    B.send({ t: 'toggleReady' });
    await A.waitFor((m) => m.t === 'room' && m.room.players.every((p) => p.ready));
    A.send({ t: 'startGame' });
    const gs = await A.waitFor((m) => m.t === 'gameStart', 5000);
    await B.waitFor((m) => m.t === 'gameStart', 5000);
    console.log(`✓ 开局成功（${gs.w}x${gs.h}，A=${gs.players[0].name}）`);
    const slotA = gs.you;

    // 等几个 tick，将军攒够 2 兵后行军
    let moved = false;
    for (let i = 0; i < 40 && !moved; i++) {
      await sleep(300);
      const tick = A.lastTick();
      if (!tick) continue;
      const w = tick.w;
      const h = tick.h;
      const gen = tick.owner.findIndex((o, idx) => tick.terrain[idx] === T_GENERAL && o === slotA);
      if (gen < 0 || tick.army[gen] <= 1) continue;
      const gx = gen % w;
      const gy = (gen / w) | 0;
      const nbs = [];
      if (gx > 0) nbs.push(gen - 1);
      if (gx < w - 1) nbs.push(gen + 1);
      if (gy > 0) nbs.push(gen - w);
      if (gy < h - 1) nbs.push(gen + w);
      const to = nbs.find((x) => tick.terrain[x] !== T_MOUNTAIN);
      if (to === undefined) continue;
      A.send({ t: 'move', from: gen, to, half: false });
      const ack = await A.waitFor((m) => m.t === 'ackMove' && m.from === gen && m.to === to, 5000);
      if (!ack.ok) throw new Error('行军被拒：' + ack.reason);
      moved = true;
    }
    if (!moved) throw new Error('没找到行军机会');
    // 确认服务端执行了这步
    let executed = false;
    for (let i = 0; i < 20; i++) {
      await sleep(300);
      const tick = A.lastTick();
      if (tick && tick.lastMoves.some((m) => m.by === slotA)) {
        executed = true;
        break;
      }
    }
    if (!executed) throw new Error('服务端未执行行军指令');
    console.log('✓ 行军指令下发 + 执行成功');

    // A 投降 → A 出局，游戏继续
    A.send({ t: 'surrender' });
    await A.waitFor((m) => m.t === 'tick' && !m.alive[slotA], 5000);
    console.log('✓ 投降成功（A 出局）');

    // B 投降 → 只剩电脑，结算
    const gsB = B.inbox.find((m) => m.t === 'gameStart');
    B.send({ t: 'surrender' });
    const over = await B.waitFor((m) => m.t === 'gameOver', 8000);
    if (over.winner === gsB.you || over.winner === slotA) {
      throw new Error('胜者不应是已投降玩家');
    }
    console.log(`✓ 结算成功（胜者 slot=${over.winner}，${over.turns} 回合）`);

    // 离房
    A.send({ t: 'leaveRoom' });
    await A.waitFor((m) => m.t === 'leftRoom', 5000);
    console.log('✓ 离房成功');

    A.close();
    B.close();
    await sleep(300);
    console.log('\n联机集成测试通过 ✅');
  } finally {
    kill();
  }
}

main().catch((e) => {
  console.error('\n❌ 集成测试失败：', e.message);
  process.exit(1);
});
