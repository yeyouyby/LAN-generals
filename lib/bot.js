'use strict';

/**
 * 简单电脑 AI：优先抓将军 > 打玩家 > 占城市 > 开荒
 * 策略：挑几个兵最多的格子，BFS 找最近的“打得过”的目标，走第一步。
 * （也用于掉线玩家的托管。）
 */

const { T_MOUNTAIN, T_CITY, T_GENERAL } = require('./game');

function shuffled(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const t = a[i];
    a[i] = a[j];
    a[j] = t;
  }
  return a;
}

function neighborsOf(i, w, h) {
  const x = i % w;
  const y = (i / w) | 0;
  const r = [];
  if (x > 0) r.push(i - 1);
  if (x < w - 1) r.push(i + 1);
  if (y > 0) r.push(i - w);
  if (y < h - 1) r.push(i + w);
  return r;
}

/**
 * 从 s 出发 BFS，找最近的可攻击目标。
 * @returns {{step:number,target:number,dist:number}|null} step 为第一步
 */
function bfsStep(game, pi, s) {
  const { w, h, n, terrain, owner, army } = game;
  const power = army[s] - 1; // 能派出的兵
  if (power < 1) return null;

  const prev = new Int32Array(n).fill(-1);
  prev[s] = s;
  const queue = [s];
  let head = 0;
  while (head < queue.length) {
    const cur = queue[head++];
    for (const nb of shuffled(neighborsOf(cur, w, h))) {
      if (prev[nb] !== -1) continue;
      if (terrain[nb] === T_MOUNTAIN) continue;
      prev[nb] = cur;
      const o = owner[nb];
      const t = terrain[nb];
      if (o !== pi) {
        // 是否打得过？
        const guard = army[nb];
        let ok = false;
        if (o < 0) {
          // 中立：平原随便打；城市要兵力碾压
          ok = t !== T_CITY && t !== T_GENERAL ? true : power > guard + 1;
        } else {
          // 玩家格：兵多就打；将军营哪怕劣势也赌一把（斩首价值高）
          ok = t === T_GENERAL ? power >= guard : power > guard;
        }
        if (ok) {
          // 回溯第一步
          let node = nb;
          let dist = 1;
          while (prev[node] !== s) {
            node = prev[node];
            dist++;
          }
          return { step: node, target: nb, dist };
        }
        // 打不过也继续穿过去找更远的目标？不——绕开，避免送兵。
        // 但仍将其加入队列以便绕行。
      }
      queue.push(nb);
    }
  }
  return null;
}

function targetPriority(game, pi, target) {
  const { terrain, owner } = game;
  const t = terrain[target];
  const o = owner[target];
  if (t === T_GENERAL && o >= 0 && o !== pi) return 100; // 斩首
  if (o >= 0 && o !== pi) return 60; // 打玩家
  if (t === T_CITY || t === T_GENERAL) return 40; // 中立城市/旧将军营
  return 10; // 开荒
}

function planBotMoves(game, pi) {
  const p = game.players[pi];
  if (!p || !p.alive) return [];
  if (p.moves.length >= 2) return [];

  const { n, owner, army } = game;
  const sources = [];
  for (let i = 0; i < n; i++) {
    if (owner[i] === pi && army[i] > 1) sources.push(i);
  }
  if (!sources.length) return [];
  sources.sort((a, b) => army[b] - army[a]);

  let best = null;
  const cands = sources.slice(0, 8);
  for (const s of cands) {
    const found = bfsStep(game, pi, s);
    if (!found) continue;
    const score =
      targetPriority(game, pi, found.target) * 1000 - found.dist * 10 + Math.min(army[s], 200);
    if (!best || score > best.score) {
      best = { from: s, to: found.step, half: false, score };
    }
  }
  if (!best) return [];
  return [{ from: best.from, to: best.to, half: best.half }];
}

module.exports = { planBotMoves };
