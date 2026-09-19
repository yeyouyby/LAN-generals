'use strict';

/** 纯逻辑测试：建图 / 规则 / 迷雾 / 完整 AI 对局（无需网络） */

const assert = require('assert');
const {
  Game,
  T_PLAIN,
  T_MOUNTAIN,
  T_CITY,
  T_GENERAL,
  FOG_TERRAIN,
  FOG_OWNER,
} = require('../lib/game');
const { planBotMoves } = require('../lib/bot');

function bots(n) {
  return Array.from({ length: n }, (_, i) => ({ name: 'AI' + i, isBot: true }));
}

// ---- 1. 多人数建图 ----
for (const n of [2, 3, 5, 8]) {
  const g = new Game({ w: 16, h: 16, players: bots(n), cityCount: 2 + n });
  let generals = 0;
  let cities = 0;
  for (let i = 0; i < g.n; i++) {
    if (g.terrain[i] === T_GENERAL) generals++;
    if (g.terrain[i] === T_CITY) cities++;
  }
  assert.strictEqual(generals, n, `${n}人图应有${n}座将军营`);
  assert.strictEqual(cities, 2 + n, '城市数量不对');
  // 每个将军营都有出路（3x3 无山）
  for (let p = 0; p < n; p++) {
    const gen = g.players[p].general;
    assert.ok(gen >= 0, '将军营位置缺失');
    assert.strictEqual(g.owner[gen], p);
    assert.strictEqual(g.terrain[gen], T_GENERAL);
  }
}
console.log('✓ 建图测试通过');

// ---- 2. 指令校验 ----
{
  const g = new Game({ w: 10, h: 10, players: [{ name: 'A' }, { name: 'B' }] });
  const gen = g.players[0].general;
  const nb = g._neighbors(gen).find((i) => g.terrain[i] !== T_MOUNTAIN);
  assert.ok(nb !== undefined, '将军营旁应有可通行格');
  assert.strictEqual(g.queueMove(0, gen, nb, false).ok, true, '合法移动应入队');
  assert.strictEqual(g.queueMove(0, gen, gen, false).ok, false, '原地踏步应拒绝');
  assert.strictEqual(g.queueMove(0, 0, 99, false).ok, false, '不相邻应拒绝');
  // 造一座山挡路
  g.terrain[nb] = T_MOUNTAIN;
  assert.strictEqual(g.queueMove(0, gen, nb, false).ok, false, '山地应拒绝');
  g.undoMove(0);
  assert.strictEqual(g.players[0].moves.length, 0, '撤销应清空队列');
}
console.log('✓ 指令校验测试通过');

// ---- 3. 半数出兵 ----
{
  const g = new Game({ w: 8, h: 8, players: [{ name: 'A' }, { name: 'B' }] });
  const gen = g.players[0].general;
  const nb = g._neighbors(gen).find((i) => g.terrain[i] === T_PLAIN && g.owner[i] === -1);
  g.army[gen] = 10;
  g.queueMove(0, gen, nb, true);
  g.step(null);
  assert.strictEqual(g.army[gen], 5 + 1, '半数出兵后出发格应剩一半（+将军营生产）');
  assert.strictEqual(g.army[nb], 5, '目标格应得到一半兵力');
  assert.strictEqual(g.owner[nb], 0);
}
console.log('✓ 半数出兵测试通过');

// ---- 4. 抓将军 → 接管 + 获胜 ----
{
  const g = new Game({ w: 8, h: 8, players: [{ name: 'A' }, { name: 'B' }] });
  const gb = g.players[1].general;
  const nb = g._neighbors(gb).find((i) => g.terrain[i] !== T_MOUNTAIN);
  g.owner[nb] = 0;
  g.army[nb] = 50;
  g.queueMove(0, nb, gb, false);
  g.step(null);
  assert.strictEqual(g.players[1].alive, false, '被抓将军应淘汰');
  assert.strictEqual(g.over, true, '只剩一人应对局结束');
  assert.strictEqual(g.winner, 0);
  assert.ok(g.events.some((e) => e.type === 'general'), '应有斩首事件');
}
console.log('✓ 抓将军测试通过');

// ---- 5. 投降 ----
{
  const g = new Game({ w: 8, h: 8, players: [{ name: 'A' }, { name: 'B' }, { name: 'C' }] });
  assert.strictEqual(g.surrender(1), true);
  assert.strictEqual(g.players[1].alive, false);
  assert.strictEqual(g.over, false, '还剩两人不应结束');
  assert.strictEqual(g.surrender(2), true);
  assert.strictEqual(g.over, true);
  assert.strictEqual(g.winner, 0);
}
console.log('✓ 投降测试通过');

// ---- 6. 战争迷雾 ----
{
  const g = new Game({ w: 20, h: 20, players: bots(2) });
  const v = g.viewFor(0);
  let fog = 0;
  for (let i = 0; i < g.n; i++) {
    if (v.terrain[i] === FOG_TERRAIN) fog++;
  }
  assert.ok(fog > g.n / 2, '开局大部分地图应对玩家不可见');
  const gen = g.players[0].general;
  assert.strictEqual(v.owner[gen], 0, '己方将军营应可见');
  assert.strictEqual(v.terrain[gen], T_GENERAL);
  // 行军轨迹同样受迷雾过滤，黑暗中的敌军箭头不能被客户端收到。
  const hiddenFrom = g.terrain.findIndex((_, i) => v.terrain[i] === FOG_TERRAIN);
  const hiddenTo = g._neighbors(hiddenFrom).find((i) => v.terrain[i] === FOG_TERRAIN);
  g.lastMoves = [{ from: hiddenFrom, to: hiddenTo, by: 1 }];
  assert.strictEqual(g.viewFor(0).lastMoves.length, 0, '迷雾中的行军箭头应被隐藏');
  const full = g.fullView();
  assert.ok(!full.terrain.includes(FOG_TERRAIN), '上帝视角不应有迷雾');
  assert.ok(!full.owner.includes(FOG_OWNER), '上帝视角不应有迷雾归属');
}
console.log('✓ 战争迷雾测试通过');

// ---- 7. 完整 AI 对局（4 电脑，应自然分出胜负） ----
{
  const g = new Game({ w: 18, h: 18, players: bots(4), cityCount: 6, maxTurns: 1500 });
  let guard = 0;
  while (!g.over && guard < 1600) {
    g.step(planBotMoves);
    guard++;
  }
  assert.ok(g.over, '对局应在回合上限内结束');
  assert.ok(g.winner >= 0 && g.winner < 4, '应有合法胜者');
  console.log(`✓ 完整对局测试通过（${g.turn} 回合，胜者 AI${g.winner}）`);
}

// ---- 8. 生产节奏 ----
{
  const g = new Game({ w: 6, h: 6, players: [{ name: 'A' }, { name: 'B' }] });
  const gen = g.players[0].general;
  for (let i = 0; i < 25; i++) g.step(null);
  // 将军营：1 + 25（每回合）+ 1（第25回合全体）= 27
  assert.strictEqual(g.army[gen], 27, `将军营25回合后应为27兵，实际${g.army[gen]}`);
}
console.log('✓ 生产节奏测试通过');

console.log('\n全部逻辑测试通过 ✅');
