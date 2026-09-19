'use strict';

/**
 * LAN-generals 核心规则引擎（服务端权威判定）
 *
 * 玩法对标 generals.io：
 * - 每人一座将军营（♛），每回合 +1 兵
 * - 中立城市（◆）初始有重兵，攻下后每回合 +1 兵
 * - 每 25 回合，所有己方土地 +1 兵
 * - 每次行动把一格兵力（留 1 个）移到相邻格；相撞拼兵力
 * - 抓住对方将军营则接管其全部土地；活到最后者获胜
 * - 战争迷雾：只能看到己方土地及周边
 */

// 地形
const T_PLAIN = 0;
const T_MOUNTAIN = 1;
const T_CITY = 2;
const T_GENERAL = 3;

// 迷雾中的填充值
const FOG_TERRAIN = -1;
const FOG_OWNER = -2;
const NEUTRAL = -1;

const LAND_ROUND = 25; // 每 N 回合全体土地 +1
const ARMY_CAP = 9999;
const MAX_QUEUE = 64; // 每人指令队列上限

function rand(n) {
  return Math.floor(Math.random() * n);
}

function shuffled(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = rand(i + 1);
    const t = a[i];
    a[i] = a[j];
    a[j] = t;
  }
  return a;
}

class Game {
  /**
   * @param {Object} opts
   * @param {number} opts.w 地图宽
   * @param {number} opts.h 地图高
   * @param {Array<{name:string,isBot:boolean,connected?:boolean}>} opts.players
   * @param {number} [opts.mountainDensity]
   * @param {number} [opts.cityCount]
   * @param {number} [opts.maxTurns]
   */
  constructor(opts) {
    this.w = opts.w;
    this.h = opts.h;
    this.n = opts.w * opts.h;
    this.turn = 0;
    this.maxTurns = opts.maxTurns || 1500;
    this.landRound = LAND_ROUND;
    this.over = false;
    this.winner = -1;
    this.events = [];
    this.lastMoves = [];
    this.players = opts.players.map((p, i) => ({
      index: i,
      name: String(p.name || `玩家${i + 1}`).slice(0, 16),
      isBot: !!p.isBot,
      connected: p.isBot ? true : p.connected !== false,
      alive: true,
      general: -1,
      moves: [],
      discovered: new Set(),
    }));
    this._genMap(opts.mountainDensity ?? 0.16, opts.cityCount ?? 5);
    for (let i = 0; i < this.players.length; i++) this._refreshDiscovered(i);
  }

  // ---------- 地图生成 ----------

  _genMap(density, cityCount) {
    for (let attempt = 0; attempt < 300; attempt++) {
      const m = this._tryGenMap(density, cityCount);
      if (m) {
        this.terrain = m.terrain;
        this.army = m.army;
        this.owner = m.owner;
        return;
      }
    }
    // 极端情况下降低山体密度兜底
    const m = this._tryGenMap(0.06, cityCount) || this._tryGenMap(0, cityCount);
    if (!m) throw new Error('地图生成失败');
    this.terrain = m.terrain;
    this.army = m.army;
    this.owner = m.owner;
  }

  _tryGenMap(density, cityCount) {
    const { w, h, n } = this;
    const count = this.players.length;
    const terrain = new Int8Array(n); // 默认平原
    const army = new Int16Array(n);
    const owner = new Int8Array(n).fill(NEUTRAL);

    // 用“种子 + 生长”生成山脉，而不是盐胡椒噪声。这样山地会形成可辨识的
    // 山脉块，同时保留足够多的开阔地，地图看起来更接近 generals.io。
    const mountainTarget = Math.floor(n * Math.max(0, Math.min(0.34, density)));
    let mountainCount = 0;
    const seeds = [];
    const seedTarget = Math.max(1, Math.round(mountainTarget / 7));
    for (let t = 0; t < 500 && seeds.length < seedTarget; t++) {
      const i = rand(n);
      const x = i % w;
      const y = (i / w) | 0;
      if (seeds.every((s) => Math.abs((s % w) - x) + Math.abs(((s / w) | 0) - y) >= 3)) {
        seeds.push(i);
        terrain[i] = T_MOUNTAIN;
        mountainCount++;
      }
    }
    const frontier = seeds.slice();
    while (mountainCount < mountainTarget && frontier.length) {
      const at = rand(frontier.length);
      const from = frontier[at];
      const choices = this._neighborsOf(from, w, h).filter((i) => terrain[i] === T_PLAIN);
      if (!choices.length) { frontier.splice(at, 1); continue; }
      // 优先填充已有山体旁边的格子，形成紧凑山块；少量随机性避免每张图都规则化。
      let best = choices[0]; let bestScore = -1;
      for (const candidate of choices) {
        const around = this._neighborsOf(candidate, w, h)
          .reduce((sum, i) => sum + (terrain[i] === T_MOUNTAIN ? 1 : 0), 0);
        const score = around * 4 + Math.random() * 3;
        if (score > bestScore) { best = candidate; bestScore = score; }
      }
      const next = best;
      terrain[next] = T_MOUNTAIN;
      frontier.push(next);
      mountainCount++;
      // 偶尔从旧种子重新开始，让多个山块均匀长大。
      if (Math.random() < 0.12) frontier.push(seeds[rand(seeds.length)]);
    }

    // 将军营采用“最远点采样”：每个新出生点都尽量远离已有出生点，
    // 比单纯随机更均衡；失败时由外层重抽地图。
    const minDist = Math.max(3, Math.floor((w + h) / (count + 1)) - (Math.min(w, h) <= 8 ? 1 : 0));
    const edgeBuffer = Math.min(2, Math.max(1, Math.floor(Math.min(w, h) / 5)));
    const generals = [];
    for (let p = 0; p < count; p++) {
      let best = -1;
      let bestScore = -1;
      for (let t = 0; t < 180; t++) {
        const i = rand(n);
        if (terrain[i] !== T_PLAIN) continue;
        const x = i % w; const y = (i / w) | 0;
        const edge = Math.min(x, y, w - 1 - x, h - 1 - y);
        // 出生点不贴边：贴边会让战争迷雾和扩张方向都明显偏斜。
        if (edge < edgeBuffer) continue;
        const spacing = generals.length ? Math.min(...generals.map((g) => {
          return Math.abs((g % w) - x) + Math.abs(((g / w) | 0) - y);
        })) : 99;
        // 对后续出生点也施加边缘惩罚，避免第一个点在中心、其余点被推到角落。
        const score = Math.min(spacing, edge * 3) + Math.random() * 0.01;
        if (score > bestScore) { best = i; bestScore = score; }
      }
      if (best < 0 || (generals.length && bestScore < minDist - 0.5)) return null;
      generals.push(best);
    }

    // 将军营周围 3x3 清空，保证有出路
    for (let p = 0; p < count; p++) {
      const g = generals[p];
      const gx = g % w;
      const gy = (g / w) | 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const x = gx + dx;
          const y = gy + dy;
          if (x >= 0 && y >= 0 && x < w && y < h) terrain[y * w + x] = T_PLAIN;
        }
      }
      terrain[g] = T_GENERAL;
      owner[g] = p;
      army[g] = 1;
      this.players[p].general = g;
      this.players[p].discovered = new Set();
    }

    // 中立城市：远离出生点并彼此拉开，避免某人开局就在城旁边，
    // 也避免城市挤成一团。候选不足时逐级放宽距离，保证小地图可生成。
    const cities = [];
    for (let c = 0; c < cityCount; c++) {
      let pos = -1;
      for (const gap of [4, 3, 2, 1]) {
        for (let t = 0; t < 500 && pos < 0; t++) {
          const i = rand(n);
          if (terrain[i] !== T_PLAIN || owner[i] !== NEUTRAL) continue;
          const x = i % w; const y = (i / w) | 0;
          if (Math.min(x, y, w - 1 - x, h - 1 - y) < 1) continue;
          const farEnough = generals.every((g) => Math.abs((g % w) - x) + Math.abs(((g / w) | 0) - y) >= gap)
            && cities.every((q) => Math.abs((q % w) - x) + Math.abs(((q / w) | 0) - y) >= gap);
          if (farEnough) pos = i;
        }
        if (pos >= 0) break;
      }
      // 候选距离在极小或高密度地图上可能不足，最后退化为任意安全平原，
      // 不牺牲“地图必定可玩”的保证。
      if (pos < 0) {
        for (let t = 0; t < n; t++) {
          const i = rand(n);
          if (terrain[i] === T_PLAIN && owner[i] === NEUTRAL) { pos = i; break; }
        }
      }
      if (pos < 0) return null;
      terrain[pos] = T_CITY;
      army[pos] = 30 + rand(16); // 30~45 守军
      cities.push(pos);
    }

    // 连通性检查：从 1 号将军出发，能走到所有将军营和城市
    const seen = new Uint8Array(n);
    const queue = [generals[0]];
    seen[generals[0]] = 1;
    while (queue.length) {
      const cur = queue.pop();
      for (const nb of this._neighborsOf(cur, w, h)) {
        if (!seen[nb] && terrain[nb] !== T_MOUNTAIN) {
          seen[nb] = 1;
          queue.push(nb);
        }
      }
    }
    for (const g of generals) if (!seen[g]) return null;
    for (const c of cities) if (!seen[c]) return null;

    return { terrain, army, owner };
  }

  _neighborsOf(i, w, h) {
    const x = i % w;
    const y = (i / w) | 0;
    const r = [];
    if (x > 0) r.push(i - 1);
    if (x < w - 1) r.push(i + 1);
    if (y > 0) r.push(i - w);
    if (y < h - 1) r.push(i + w);
    return r;
  }

  _neighbors(i) {
    return this._neighborsOf(i, this.w, this.h);
  }

  _in(i) {
    return Number.isInteger(i) && i >= 0 && i < this.n;
  }

  _adjacent(a, b) {
    const ax = a % this.w;
    const ay = (a / this.w) | 0;
    const bx = b % this.w;
    const by = (b / this.w) | 0;
    return Math.abs(ax - bx) + Math.abs(ay - by) === 1;
  }

  // ---------- 视野 / 迷雾 ----------

  /** 当前可见格（含城市/将军营 2 格视野） */
  _visibleSet(pi) {
    const { w, h } = this;
    const vis = new Set();
    for (let i = 0; i < this.n; i++) {
      if (this.owner[i] !== pi) continue;
      const t = this.terrain[i];
      const R = t === T_CITY || t === T_GENERAL ? 2 : 1;
      const x = i % w;
      const y = (i / w) | 0;
      for (let dy = -R; dy <= R; dy++) {
        for (let dx = -R; dx <= R; dx++) {
          if (Math.abs(dx) + Math.abs(dy) > R) continue;
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          vis.add(ny * w + nx);
        }
      }
    }
    return vis;
  }

  _refreshDiscovered(pi) {
    const d = this.players[pi].discovered;
    for (const x of this._visibleSet(pi)) d.add(x);
  }

  /** 某玩家的迷雾视角 */
  viewFor(pi) {
    const vis = this._visibleSet(pi);
    const d = this.players[pi].discovered;
    const terrain = new Array(this.n);
    const owner = new Array(this.n);
    const army = new Array(this.n);
    for (let i = 0; i < this.n; i++) {
      if (!d.has(i)) {
        terrain[i] = FOG_TERRAIN;
        owner[i] = FOG_OWNER;
        army[i] = 0;
      } else {
        terrain[i] = this.terrain[i];
        if (vis.has(i)) {
          owner[i] = this.owner[i];
          army[i] = this.army[i];
        } else {
          owner[i] = FOG_OWNER;
          army[i] = 0;
        }
      }
    }
    // 行军轨迹也属于战争迷雾：只有起点和终点当前都在视野内才广播。
    // 否则敌人在黑暗中的箭头会暴露其位置和进攻方向。
    const visibleMoves = this.lastMoves.filter((m) => vis.has(m.from) && vis.has(m.to));
    return {
      turn: this.turn,
      w: this.w,
      h: this.h,
      terrain,
      owner,
      army,
      you: pi,
      alive: this.players.map((p) => p.alive),
      scores: this.scores(),
      yourMoves: this.players[pi].moves.map((m) => ({ from: m.from, to: m.to, half: m.half })),
      lastMoves: visibleMoves,
      events: this.events,
      over: this.over,
      winner: this.winner,
    };
  }

  /** 上帝视角（观战 / 已阵亡玩家） */
  fullView() {
    return {
      turn: this.turn,
      w: this.w,
      h: this.h,
      terrain: Array.from(this.terrain),
      owner: Array.from(this.owner),
      army: Array.from(this.army),
      you: -1,
      alive: this.players.map((p) => p.alive),
      scores: this.scores(),
      yourMoves: [],
      lastMoves: this.lastMoves,
      events: this.events,
      over: this.over,
      winner: this.winner,
    };
  }

  scores() {
    const s = this.players.map(() => ({ army: 0, land: 0 }));
    for (let i = 0; i < this.n; i++) {
      const o = this.owner[i];
      if (o >= 0 && this.terrain[i] !== T_MOUNTAIN) {
        s[o].army += this.army[i];
        s[o].land += 1;
      }
    }
    return s;
  }

  // ---------- 指令 ----------

  /**
   * 把一步移动加入队列。入队时只校验相邻与可通行，
   * 归属/兵力在执行时再校验（支持穿越未来占领格的连续路径）。
   */
  queueMove(pi, from, to, half = false) {
    const p = this.players[pi];
    if (this.over) return { ok: false, reason: '游戏已结束' };
    if (!p || !p.alive) return { ok: false, reason: '你已被淘汰' };
    if (p.moves.length >= MAX_QUEUE) return { ok: false, reason: '指令队列已满' };
    if (!this._in(from) || !this._in(to)) return { ok: false, reason: '坐标越界' };
    if (from === to) return { ok: false, reason: '原地踏步？' };
    if (!this._adjacent(from, to)) return { ok: false, reason: '只能走到相邻格' };
    if (this.terrain[from] === T_MOUNTAIN || this.terrain[to] === T_MOUNTAIN) {
      return { ok: false, reason: '山地不可通行' };
    }
    p.moves.push({ from, to, half: !!half });
    return { ok: true };
  }

  undoMove(pi) {
    const p = this.players[pi];
    if (!p || !p.alive || !p.moves.length) return false;
    p.moves.pop();
    return true;
  }

  clearMoves(pi) {
    const p = this.players[pi];
    if (!p || !p.alive) return false;
    p.moves = [];
    return true;
  }

  surrender(pi) {
    if (this.over) return false;
    const p = this.players[pi];
    if (!p || !p.alive) return false;
    this._eliminate(pi, -1, true);
    const alive = this.players.filter((q) => q.alive);
    if (alive.length <= 1) {
      this.over = true;
      this.winner = alive.length ? alive[0].index : -1;
      if (this.winner >= 0) {
        this.events.push({
          type: 'over',
          text: `${this.players[this.winner].name} 赢得胜利！`,
          a: this.winner,
        });
      }
    }
    return true;
  }

  _eliminate(victim, by, surrendered) {
    const p = this.players[victim];
    if (!p.alive) return;
    p.alive = false;
    p.moves = [];
    if (by >= 0) {
      // 抓将军：全部土地易主
      for (let k = 0; k < this.n; k++) {
        if (this.owner[k] === victim) this.owner[k] = by;
      }
      if (!surrendered) {
        this.events.push({
          type: 'eliminate',
          text: `💀 ${p.name} 被 ${this.players[by].name} 消灭！`,
          a: by,
          b: victim,
        });
      }
    } else {
      // 投降：土地变中立，将军营变普通城市
      for (let k = 0; k < this.n; k++) {
        if (this.owner[k] === victim) {
          this.owner[k] = NEUTRAL;
          this.army[k] = Math.floor(this.army[k] / 2);
          if (this.terrain[k] === T_GENERAL) this.terrain[k] = T_CITY;
        }
      }
      this.events.push({ type: 'eliminate', text: `🏳️ ${p.name} 投降了！`, a: victim });
    }
  }

  // ---------- 回合推进 ----------

  /**
   * 执行一回合。
   * @param {(game:Game, pi:number)=>Array<{from:number,to:number,half:boolean}>} [planner]
   *   电脑 / 掉线托管的出兵策略
   */
  step(planner) {
    if (this.over) return;
    this.turn += 1;
    this.events = [];
    this.lastMoves = [];

    // 电脑与掉线玩家自动出兵
    if (planner) {
      for (let i = 0; i < this.players.length; i++) {
        const p = this.players[i];
        if (!p.alive) continue;
        if (p.isBot || !p.connected) {
          try {
            const ms = planner(this, i) || [];
            for (const m of ms) {
              this.queueMove(i, m.from, m.to, m.half);
              if (p.moves.length >= 8) break;
            }
          } catch (e) {
            // AI 异常不影响主循环
          }
        }
      }
    }

    // 每人执行队列中的一步（顺序随机，保证公平）
    const order = shuffled(this.players.map((p) => p.index));
    for (const i of order) {
      const p = this.players[i];
      if (!p.alive || !p.moves.length) continue;
      const m = p.moves.shift();
      this._execMove(i, m);
    }

    // 生产：城市 / 将军营每回合 +1
    for (let k = 0; k < this.n; k++) {
      const o = this.owner[k];
      if (o < 0) continue;
      const t = this.terrain[k];
      if (t === T_CITY || t === T_GENERAL) {
        if (this.army[k] < ARMY_CAP) this.army[k] += 1;
      }
    }
    // 每 N 回合：所有土地 +1
    if (this.turn % this.landRound === 0) {
      for (let k = 0; k < this.n; k++) {
        if (this.owner[k] >= 0 && this.terrain[k] !== T_MOUNTAIN) {
          if (this.army[k] < ARMY_CAP) this.army[k] += 1;
        }
      }
    }

    for (let i = 0; i < this.players.length; i++) {
      if (this.players[i].alive) this._refreshDiscovered(i);
    }

    // 胜负判定
    const alive = this.players.filter((p) => p.alive);
    if (alive.length <= 1) {
      this.over = true;
      this.winner = alive.length ? alive[0].index : -1;
      this.events.push({
        type: 'over',
        text: alive.length ? `${alive[0].name} 赢得胜利！` : '无人获胜',
        a: this.winner,
      });
    } else if (this.turn >= this.maxTurns) {
      this.over = true;
      const s = this.scores();
      let best = alive[0].index;
      let bl = -1;
      let ba = -1;
      for (const p of alive) {
        const sc = s[p.index];
        if (sc.land > bl || (sc.land === bl && sc.army > ba)) {
          best = p.index;
          bl = sc.land;
          ba = sc.army;
        }
      }
      this.winner = best;
      this.events.push({
        type: 'over',
        text: `回合数耗尽，${this.players[best].name} 以 ${bl} 块土地获胜！`,
        a: best,
      });
    }
  }

  _execMove(pi, m) {
    const { from, to, half } = m;
    if (!this._in(from) || !this._in(to)) return false;
    if (!this._adjacent(from, to)) return false;
    if (this.owner[from] !== pi) return false;
    if (this.terrain[to] === T_MOUNTAIN) return false;
    const a = this.army[from];
    if (a <= 1) return false;
    const moving = half ? Math.floor(a / 2) : a - 1;
    if (moving < 1) return false;
    this.army[from] = a - moving;

    const o = this.owner[to];
    const t = this.terrain[to];
    if (o === pi) {
      this.army[to] = Math.min(ARMY_CAP, this.army[to] + moving);
    } else {
      const na = this.army[to] - moving;
      if (na < 0) {
        this.owner[to] = pi;
        this.army[to] = Math.min(ARMY_CAP, -na);
        if (t === T_GENERAL && o >= 0 && this.players[o].alive && o !== pi) {
          this.events.push({
            type: 'general',
            text: `⚔️ ${this.players[pi].name} 抓住了 ${this.players[o].name} 的将军！`,
            a: pi,
            b: o,
          });
          this._eliminate(o, pi, false);
        } else if (t === T_CITY && o === NEUTRAL) {
          this.events.push({
            type: 'city',
            text: `🏙️ ${this.players[pi].name} 占领了一座城市！`,
            a: pi,
          });
        }
      } else {
        this.army[to] = na; // 拼光 / 守住
      }
    }
    this.lastMoves.push({ from, to, by: pi });
    return true;
  }
}

module.exports = {
  Game,
  T_PLAIN,
  T_MOUNTAIN,
  T_CITY,
  T_GENERAL,
  FOG_TERRAIN,
  FOG_OWNER,
  NEUTRAL,
  LAND_ROUND,
  MAX_QUEUE,
};
