'use strict';

/* ================= 常量与状态 ================= */

const $ = (id) => document.getElementById(id);

const T_PLAIN = 0;
const T_MOUNTAIN = 1;
const T_CITY = 2;
const T_GENERAL = 3;
const FOG_T = -1;
const FOG_O = -2;
const NEUTRAL = -1;

const COLORS = ['#3b82f6', '#ef4444', '#22c55e', '#eab308', '#a855f7', '#f97316', '#06b6d4', '#ec4899'];
const DIM = COLORS.map((c) => shade(c, -45));

function shade(hex, amt) {
  const n = parseInt(hex.slice(1), 16);
  const r = Math.max(0, Math.min(255, (n >> 16) + amt));
  const g = Math.max(0, Math.min(255, ((n >> 8) & 255) + amt));
  const b = Math.max(0, Math.min(255, (n & 255) + amt));
  return '#' + ((r << 16) | (g << 8) | b).toString(16).padStart(6, '0');
}

const S = {
  ws: null,
  retry: 0,
  clientId: null,
  token: localStorage.getItem('lg_token') || '',
  name: localStorage.getItem('lg_name') || '',
  screen: 'lobby',
  roomId: null,
  room: null,
  chat: [],
  chatKeys: new Set(),
  game: null,
  modal: false,
  muted: localStorage.getItem('lg_muted') === '1',
};

/* ================= 音效 ================= */

let AC = null;
function ac() {
  if (!AC) {
    try {
      AC = new (window.AudioContext || window.webkitAudioContext)();
    } catch (e) {
      AC = null;
    }
  }
  if (AC && AC.state === 'suspended') AC.resume();
  return AC;
}
document.addEventListener('pointerdown', () => ac(), { once: true });

function tone(freq, dur, type = 'sine', vol = 0.14, when = 0) {
  if (S.muted) return;
  const c = ac();
  if (!c) return;
  try {
    const t = c.currentTime + when;
    const o = c.createOscillator();
    const g = c.createGain();
    o.type = type;
    o.frequency.value = freq;
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(g);
    g.connect(c.destination);
    o.start(t);
    o.stop(t + dur + 0.03);
  } catch (e) {
    /* ignore */
  }
}
const sfx = {
  click: () => tone(620, 0.06, 'square', 0.05),
  move: () => tone(500, 0.05, 'square', 0.045),
  coin: () => {
    tone(880, 0.09);
    tone(1318, 0.14, 'sine', 0.14, 0.08);
  },
  alarm: () => {
    for (let i = 0; i < 3; i++) tone(233, 0.15, 'sawtooth', 0.11, i * 0.19);
  },
  boom: () => tone(110, 0.4, 'sawtooth', 0.18),
  win: () => [523, 659, 784, 1046].forEach((f, i) => tone(f, 0.2, 'triangle', 0.15, i * 0.13)),
  lose: () => [392, 311, 247, 165].forEach((f, i) => tone(f, 0.22, 'triangle', 0.13, i * 0.16)),
};

/* ================= Toast / Modal ================= */

function toast(text, cls = '', ms = 2600) {
  const box = $('toasts');
  const d = document.createElement('div');
  d.className = ('toast ' + cls).trim();
  d.textContent = text;
  box.appendChild(d);
  while (box.children.length > 4) box.removeChild(box.firstChild);
  setTimeout(() => {
    d.style.transition = 'opacity .3s';
    d.style.opacity = '0';
    setTimeout(() => d.remove(), 320);
  }, ms);
}

function showModal(title, bodyHTML, buttons) {
  S.modal = true;
  $('modalTitle').textContent = title;
  $('modalBody').innerHTML = bodyHTML;
  const bb = $('modalBtns');
  bb.innerHTML = '';
  for (const b of buttons) {
    const btn = document.createElement('button');
    btn.className = 'btn' + (b.primary ? ' primary' : '');
    btn.textContent = b.label;
    btn.onclick = () => b.fn && b.fn();
    bb.appendChild(btn);
  }
  $('modal').hidden = false;
}
function hideModal() {
  S.modal = false;
  $('modal').hidden = true;
}

/* ================= 网络 ================= */

function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws:';
  const ws = new WebSocket(proto + '//' + location.host);
  S.ws = ws;
  ws.onopen = () => {
    S.retry = 0;
    ws.send(JSON.stringify({ t: 'hello', token: S.token || undefined, name: S.name || undefined }));
  };
  ws.onmessage = (e) => {
    try {
      onMsg(JSON.parse(e.data));
    } catch (err) {
      /* ignore */
    }
  };
  ws.onclose = () => {
    if (S.ws === ws) {
      S.ws = null;
      scheduleReconnect();
    }
  };
  ws.onerror = () => {
    try {
      ws.close();
    } catch (e) {
      /* ignore */
    }
  };
}
function scheduleReconnect() {
  toast('连接断开，正在重连…', 'err');
  const d = Math.min(5000, 500 * Math.pow(2, S.retry++));
  setTimeout(() => {
    if (!S.ws) connect();
  }, d);
}
function send(m) {
  if (S.ws && S.ws.readyState === WebSocket.OPEN) S.ws.send(JSON.stringify(m));
}

function onMsg(msg) {
  switch (msg.t) {
    case 'welcome':
      S.clientId = msg.clientId;
      S.token = msg.token;
      S.name = msg.name;
      localStorage.setItem('lg_token', S.token);
      localStorage.setItem('lg_name', S.name);
      $('nameInput').value = S.name;
      break;
    case 'me':
      S.name = msg.name;
      localStorage.setItem('lg_name', S.name);
      $('nameInput').value = S.name;
      break;
    case 'lobby':
      if (S.screen === 'lobby') renderRooms(msg.rooms);
      break;
    case 'room':
      onRoom(msg.room);
      break;
    case 'gameStart':
      onGameStart(msg);
      break;
    case 'tick':
      onTick(msg);
      break;
    case 'gameOver':
      onGameOver(msg);
      break;
    case 'chat':
      onChat(msg);
      break;
    case 'ackMove':
      onAckMove(msg);
      break;
    case 'leftRoom':
      onLeftRoom();
      break;
    case 'error':
      toast(msg.msg, 'err');
      break;
    default:
      break;
  }
}

/* ================= 屏幕切换 ================= */

function showScreen(name) {
  S.screen = name;
  $('screen-lobby').hidden = name !== 'lobby';
  $('screen-room').hidden = name !== 'room';
  $('screen-game').hidden = name !== 'game';
  if (name === 'game') requestAnimationFrame(resizeCanvas);
}

/* ================= 大厅 ================= */

const STATUS_TXT = { waiting: '等待中', playing: '进行中', over: '已结束' };

function renderRooms(list) {
  const box = $('roomList');
  box.innerHTML = '';
  if (!list.length) {
    box.innerHTML = '<p class="dim">还没有房间，快创建一个吧 👈</p>';
    return;
  }
  for (const r of list) {
    const div = document.createElement('div');
    div.className = 'room-item';
    const meta =
      `${r.players}/${r.maxPlayers}人 · ${r.mapName}图 · ${r.speedName}速` +
      (r.status === 'playing' ? ` · 第${r.turn}回合` : '');
    div.innerHTML =
      `<span class="status-dot ${r.status}"></span>` +
      `<span class="rname"></span> <span class="rmeta"></span>` +
      `<span class="grow"></span>`;
    div.querySelector('.rname').textContent = r.name;
    div.querySelector('.rmeta').textContent = `${STATUS_TXT[r.status] || ''} · ${meta}`;
    const joinBtn = document.createElement('button');
    if (r.rejoin) {
      joinBtn.className = 'btn small primary';
      joinBtn.textContent = '⚔️ 重回战场';
      joinBtn.onclick = () => send({ t: 'joinRoom', roomId: r.id });
    } else {
      joinBtn.className = 'btn small' + (r.status === 'waiting' ? ' primary' : '');
      joinBtn.textContent = r.status === 'waiting' ? '加入' : '观战';
      joinBtn.onclick = () =>
        send({ t: 'joinRoom', roomId: r.id, asSpectator: r.status !== 'waiting' });
    }
    div.appendChild(joinBtn);
    if (r.status === 'waiting') {
      const spBtn = document.createElement('button');
      spBtn.className = 'btn small';
      spBtn.textContent = '观战';
      spBtn.onclick = () => send({ t: 'joinRoom', roomId: r.id, asSpectator: true });
      div.appendChild(spBtn);
    }
    box.appendChild(div);
  }
}

/* ================= 房间 ================= */

function onRoom(room) {
  if (S.roomId !== room.id) {
    S.roomId = room.id;
    S.chat = [];
    S.chatKeys.clear();
  }
  S.room = room;
  if (S.screen === 'game') {
    // 结算后服务端会推 status=over；若本局已看过结算则留在棋盘，否则回房间
    if (room.status !== 'playing' && S.game && !S.game.over) {
      showScreen('room');
      renderRoom();
    }
    return;
  }
  showScreen('room');
  renderRoom();
}

function mySlot() {
  if (!S.room) return -1;
  const p = S.room.players.find((q) => !q.isBot && q.clientId === S.clientId);
  return p ? p.slot : -1;
}

function renderRoom() {
  const room = S.room;
  if (!room) return;
  $('roomTitle').textContent = '🏠 ' + room.name;
  $('roomMeta').textContent =
    `房号 ${room.id} · ${STATUS_TXT[room.status] || ''} · ` +
    `${room.players.length}/${room.config.maxPlayers}人 · ` +
    `${{ small: '小', medium: '中', large: '大', adaptive: '自适应' }[room.config.mapSize]}图 · ` +
    `${{ slow: '慢速', normal: '标准', fast: '快速' }[room.config.speed]}速`;

  const box = $('playerList');
  box.innerHTML = '';
  const amHost = room.hostId === S.clientId;
  for (const p of room.players) {
    const row = document.createElement('div');
    row.className = 'player-row';
    const dot = document.createElement('span');
    dot.className = 'pcolor';
    dot.style.background = COLORS[p.slot % COLORS.length];
    row.appendChild(dot);
    const nm = document.createElement('span');
    nm.className = 'pname';
    nm.textContent = p.name;
    row.appendChild(nm);
    const tags = [];
    if (p.clientId === room.hostId) tags.push(['房主', 'host']);
    if (!p.isBot && p.clientId === S.clientId) tags.push(['你', 'me']);
    if (p.isBot) tags.push(['电脑', '']);
    if (!p.connected) tags.push(['离线', 'off']);
    for (const [txt, cls] of tags) {
      const s = document.createElement('span');
      s.className = ('ptag ' + cls).trim();
      s.textContent = txt;
      row.appendChild(s);
    }
    const rd = document.createElement('span');
    rd.className = 'pready ' + (p.ready ? 'ok' : 'no');
    rd.textContent = p.isBot ? '🤖' : p.clientId === room.hostId ? '👑' : p.ready ? '✅ 已准备' : '⏳ 未准备';
    row.appendChild(rd);
    if (amHost && p.isBot && room.status !== 'playing') {
      const rm = document.createElement('button');
      rm.className = 'btn small danger-ghost';
      rm.textContent = '移除';
      rm.onclick = () => send({ t: 'removeBot', slot: p.slot });
      row.appendChild(rm);
    }
    box.appendChild(row);
  }
  if (room.spectators.length) {
    const sp = document.createElement('p');
    sp.className = 'dim';
    sp.textContent = '👁 观战：' + room.spectators.map((s) => s.name).join('、');
    box.appendChild(sp);
  }

  const me = mySlot();
  const waiting = room.status === 'waiting';
  $('readyBtn').style.display = me >= 0 && !amHost && waiting ? '' : 'none';
  if (me >= 0 && !amHost) {
    const p = room.players[me];
    $('readyBtn').textContent = p.ready ? '取消准备' : '准备';
    $('readyBtn').classList.toggle('primary', !p.ready);
  }
  $('startBtn').style.display = amHost && room.status !== 'playing' ? '' : 'none';
  $('startBtn').textContent = room.status === 'over' ? '🔁 再来一局' : '⚔️ 开始游戏';
  $('addBotBtn').style.display =
    amHost && room.status !== 'playing' && room.players.length < room.config.maxPlayers ? '' : 'none';

  const humans = room.players.filter((p) => !p.isBot).length;
  $('roomTip').textContent =
    room.status === 'playing'
      ? '对局进行中…'
      : room.players.length < 2
        ? `再来 ${2 - room.players.length} 人即可开战（可加电脑凑数）`
        : humans === 0
          ? '全是电脑？至少留一位人类玩家吧'
          : amHost
            ? '你是房主，等大家准备好就可以开战了！'
            : '点击「准备」，等房主开战！';
}

/* ================= 聊天 ================= */

function onChat(m) {
  const key = m.ts + '|' + m.from + '|' + m.text;
  if (S.chatKeys.has(key)) return;
  S.chatKeys.add(key);
  if (S.chatKeys.size > 200) {
    const first = S.chatKeys.values().next().value;
    S.chatKeys.delete(first);
  }
  S.chat.push(m);
  if (S.chat.length > 100) S.chat.shift();
  renderChat();
}

function renderChat() {
  for (const id of ['roomChatLog', 'gameChatLog']) {
    const log = $(id);
    if (!log) continue;
    const nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 60;
    log.innerHTML = '';
    for (const m of S.chat) {
      const d = document.createElement('div');
      if (m.sys) {
        d.className = 'sys';
        d.textContent = m.text;
      } else {
        const who = document.createElement('span');
        who.className = 'who';
        who.textContent = m.from + '：';
        const txt = document.createElement('span');
        txt.textContent = m.text;
        d.appendChild(who);
        d.appendChild(txt);
      }
      log.appendChild(d);
    }
    if (nearBottom) log.scrollTop = log.scrollHeight;
  }
}

function sendChat(inputId) {
  const inp = $(inputId);
  const text = inp.value.trim();
  if (!text) return;
  send({ t: 'chat', text });
  inp.value = '';
}

/* ================= 对局 ================= */

function onGameStart(msg) {
  S.game = {
    you: msg.you,
    w: msg.w,
    h: msg.h,
    speed: msg.speed,
    speedMs: msg.speedMs || 500,
    players: msg.players,
    tick: null,
    selection: -1,
    pending: [],
    half: false,
    over: false,
    dangerWas: false,
    lastDangerSfx: 0,
  };
  $('halfBtn').classList.remove('on');
  hideModal();
  showScreen('game');
  toast(msg.you >= 0 ? '⚔️ 对局开始！扩张你的领土！' : '👁 你正在观战', 'good');
}

function onTick(msg) {
  const G = S.game;
  if (!G) return;
  G.tick = msg;
  prunePending();
  if (msg.you < 0 || !msg.alive[msg.you]) G.selection = -1;
  renderBoard();
  renderScore();
  renderTurnBar();
  for (const ev of (msg.events || []).slice(0, 4)) toast(ev.text);
  for (const ev of msg.events || []) {
    if (ev.type === 'general') {
      if (ev.a === msg.you || ev.b === msg.you) sfx.alarm();
    } else if (ev.type === 'city') {
      if (ev.a === msg.you) sfx.coin();
    } else if (ev.type === 'eliminate') {
      if (ev.b === msg.you) sfx.lose();
      else if (ev.a === msg.you) sfx.boom();
    }
  }
  checkDanger(msg);
  if (msg.over) G.over = true;
}

function onGameOver(msg) {
  const G = S.game;
  if (G) G.over = true;
  const you = G ? G.you : -1;
  if (you >= 0) {
    if (msg.winner === you) sfx.win();
    else sfx.lose();
  } else {
    sfx.coin();
  }
  const rows = msg.players
    .map((p, i) => ({ i, ...p, ...msg.scores[i] }))
    .sort((a, b) => b.land - a.land || b.army - a.army);
  let html = `<p class="dim">共进行 ${msg.turns} 回合</p><table class="result-table">` +
    `<tr><th>#</th><th>玩家</th><th>兵力</th><th>土地</th></tr>`;
  rows.forEach((r, rank) => {
    html += `<tr class="${r.i === msg.winner ? 'winner' : ''}"><td>${rank + 1}</td><td>${escapeHtml(r.name)}${r.i === you ? '（你）' : ''}${r.isBot ? ' 🤖' : ''}</td><td>${r.army}</td><td>${r.land}</td></tr>`;
  });
  html += '</table>';
  const title =
    msg.winner < 0 ? '🤝 无人获胜' : msg.winner === you ? `🏆 你赢了！` : `🏆 ${msg.winnerName} 获胜！`;
  const btns = [];
  const amHost = S.room && S.room.hostId === S.clientId;
  if (amHost) {
    btns.push({
      label: '🔁 再来一局',
      primary: true,
      fn: () => {
        hideModal();
        send({ t: 'startGame' });
      },
    });
  }
  btns.push({
    label: '返回房间',
    fn: () => {
      hideModal();
      if (S.room) {
        showScreen('room');
        renderRoom();
      } else {
        showScreen('lobby');
        send({ t: 'listRooms' });
      }
    },
  });
  btns.push({ label: '继续看地图', fn: hideModal });
  showModal(title, html, btns);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function onLeftRoom() {
  S.room = null;
  S.roomId = null;
  S.chat = [];
  S.chatKeys.clear();
  S.game = null;
  hideModal();
  showScreen('lobby');
  send({ t: 'listRooms' });
}

/* ---------- 指令队列（本地预显示 + 服务端回显） ---------- */

function prunePending() {
  const G = S.game;
  if (!G) return;
  const keep = G.speedMs * 1.2 + 150;
  const now = Date.now();
  G.pending = G.pending.filter((m) => now - m.ts < keep);
}

function displayQueue() {
  const G = S.game;
  if (!G || !G.tick) return [];
  prunePending();
  return G.tick.yourMoves.concat(G.pending);
}

function sendMove(from, to, half, quiet) {
  const G = S.game;
  if (!G || G.pending.length >= 64) return;
  G.pending.push({ from, to, half, ts: Date.now(), quiet: !!quiet });
  send({ t: 'move', from, to, half });
}

function onAckMove(msg) {
  const G = S.game;
  if (!G) return;
  const idx = G.pending.findIndex((m) => m.from === msg.from && m.to === msg.to);
  if (idx >= 0) {
    const [m] = G.pending.splice(idx, 1);
    if (!msg.ok && !m.quiet) toast(msg.reason || '出兵失败', 'err', 1500);
  } else if (!msg.ok) {
    toast(msg.reason || '出兵失败', 'err', 1500);
  }
  renderBoard();
  renderTurnBar();
}

function doUndo() {
  const G = S.game;
  if (!G || !G.tick || G.tick.over) return;
  send({ t: 'undoMove' });
  G.pending.pop();
  renderBoard();
  renderTurnBar();
}

function doClear() {
  const G = S.game;
  if (!G || !G.tick || G.tick.over) return;
  send({ t: 'clearMoves' });
  G.pending = [];
  renderBoard();
  renderTurnBar();
}

function toggleHalf() {
  const G = S.game;
  if (!G) return;
  G.half = !G.half;
  $('halfBtn').classList.toggle('on', G.half);
}

/* ---------- 寻路（点击远处自动规划路径） ---------- */

function findPath(v, from, to, w, h) {
  if (from === to || from < 0) return null;
  if (v.terrain[to] === T_MOUNTAIN) return null;
  const n = w * h;
  const prev = new Int32Array(n).fill(-1);
  prev[from] = from;
  const queue = [from];
  let head = 0;
  while (head < queue.length) {
    const cur = queue[head++];
    if (cur === to) break;
    const x = cur % w;
    const y = (cur / w) | 0;
    const nbs = [];
    if (x > 0) nbs.push(cur - 1);
    if (x < w - 1) nbs.push(cur + 1);
    if (y > 0) nbs.push(cur - w);
    if (y < h - 1) nbs.push(cur + w);
    for (const nb of nbs) {
      if (prev[nb] !== -1) continue;
      if (v.terrain[nb] === T_MOUNTAIN) continue; // 未知格视为可通行
      prev[nb] = cur;
      queue.push(nb);
    }
  }
  if (prev[to] === -1) return null;
  const cells = [];
  let node = to;
  while (node !== from) {
    cells.push(node);
    node = prev[node];
    if (cells.length > 24) return null;
  }
  cells.reverse();
  const steps = [];
  let cur = from;
  for (const c of cells) {
    steps.push({ from: cur, to: c });
    cur = c;
  }
  return steps;
}

/* ---------- 棋盘渲染 ---------- */

const cv = $('board');
const ctx = cv.getContext('2d');
let TILE = 20;
let HOVER = -1;

function resizeCanvas() {
  const G = S.game;
  if (!G || S.screen !== 'game') return;
  const wrap = cv.parentElement;
  const maxW = wrap.clientWidth - 16;
  const availH = Math.max(300, window.innerHeight * 0.62);
  TILE = Math.max(8, Math.floor(Math.min(maxW / G.w, availH / G.h)));
  const dpr = window.devicePixelRatio || 1;
  const W = G.w * TILE;
  const H = G.h * TILE;
  cv.width = Math.round(W * dpr);
  cv.height = Math.round(H * dpr);
  cv.style.width = 'min(100%, ' + W + 'px)';
  cv.style.aspectRatio = G.w + ' / ' + G.h;
  renderBoard();
}
window.addEventListener('resize', () => {
  if (S.screen === 'game') resizeCanvas();
});

function renderBoard() {
  const G = S.game;
  if (!G) return;
  const v = G.tick;
  const dpr = window.devicePixelRatio || 1;
  const W = G.w * TILE;
  const H = G.h * TILE;
  if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) {
    cv.width = Math.round(W * dpr);
    cv.height = Math.round(H * dpr);
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = '#05070a';
  ctx.fillRect(0, 0, W, H);
  if (!v) {
    ctx.fillStyle = '#8b94a7';
    ctx.font = '14px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('等待开局…', W / 2, H / 2);
    return;
  }
  const you = v.you;

  for (let i = 0; i < v.terrain.length; i++) {
    const x = (i % G.w) * TILE;
    const y = ((i / G.w) | 0) * TILE;
    const ter = v.terrain[i];
    const own = v.owner[i];
    const arm = v.army[i];
    let bg;
    if (ter === FOG_T) bg = '#0c1016';
    else if (ter === T_MOUNTAIN) bg = '#20262f';
    else if (own === FOG_O) bg = ter === T_PLAIN ? '#161b24' : '#1b1913';
    else if (own === NEUTRAL) bg = ter === T_CITY ? '#3a3324' : '#2b3340';
    else bg = own === you ? COLORS[own % 8] : DIM[own % 8];
    ctx.fillStyle = bg;
    ctx.fillRect(x, y, TILE, TILE);

    // 图标使用 Canvas 矢量绘制，不依赖 emoji 字体；在手机和局域网不同系统上也保持一致。
    if (ter === T_MOUNTAIN) {
      drawMountain(x, y);
    } else if (ter !== FOG_T && own !== FOG_O) {
      const isHQ = ter === T_GENERAL;
      const isCity = ter === T_CITY;
      if (isHQ && TILE >= 11) drawGeneral(x, y, own === NEUTRAL ? '#e7c45c' : '#f4f7fb');
      if (isCity && TILE >= 11) drawCity(x, y, own === NEUTRAL ? '#e7c45c' : '#f4f7fb');
      if (arm > 0 && TILE >= 12) {
        ctx.fillStyle = own === NEUTRAL ? '#d5dbe6' : '#fff';
        ctx.font = `800 ${Math.round(Math.min(15, TILE * 0.42))}px Arial, sans-serif`;
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.shadowColor = 'rgba(0,0,0,.72)'; ctx.shadowBlur = 3;
        ctx.fillText(String(arm), x + TILE / 2, y + TILE * (isHQ || isCity ? 0.72 : 0.53));
        ctx.shadowBlur = 0;
      }
    }
  }

  // 网格线
  ctx.strokeStyle = 'rgba(0,0,0,.35)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let x = 0; x <= G.w; x++) {
    ctx.moveTo(x * TILE + 0.5, 0);
    ctx.lineTo(x * TILE + 0.5, H);
  }
  for (let y = 0; y <= G.h; y++) {
    ctx.moveTo(0, y * TILE + 0.5);
    ctx.lineTo(W, y * TILE + 0.5);
  }
  ctx.stroke();

  // 他人本回合动向（淡箭头）
  if (v.lastMoves) {
    ctx.strokeStyle = 'rgba(255,255,255,.4)';
    ctx.fillStyle = 'rgba(255,255,255,.4)';
    ctx.lineWidth = Math.max(1.5, TILE * 0.08);
    for (const m of v.lastMoves) {
      if (m.by === you) continue;
      drawArrow(m.from, m.to, 0.32);
    }
  }

  // 自己的队列（黄箭头）
  const q = displayQueue();
  if (q.length) {
    ctx.strokeStyle = '#ffe066';
    ctx.fillStyle = '#ffe066';
    ctx.lineWidth = Math.max(2, TILE * 0.12);
    for (const m of q) drawArrow(m.from, m.to, 0.3);
  }

  // 选中 / 悬停
  if (G.selection >= 0 && v.yourMoves !== undefined) {
    const i = G.selection;
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 2;
    ctx.strokeRect((i % G.w) * TILE + 1.5, ((i / G.w) | 0) * TILE + 1.5, TILE - 3, TILE - 3);
  }
  if (HOVER >= 0) {
    ctx.strokeStyle = 'rgba(255,255,255,.35)';
    ctx.lineWidth = 1.5;
    ctx.strokeRect((HOVER % G.w) * TILE + 1, ((HOVER / G.w) | 0) * TILE + 1, TILE - 2, TILE - 2);
  }
}

function drawMountain(x, y) {
  const cx = x + TILE / 2;
  ctx.fillStyle = '#111820';
  ctx.beginPath(); ctx.moveTo(x + TILE * .12, y + TILE * .82); ctx.lineTo(cx, y + TILE * .16);
  ctx.lineTo(x + TILE * .9, y + TILE * .82); ctx.closePath(); ctx.fill();
  ctx.fillStyle = '#8290a2';
  ctx.beginPath(); ctx.moveTo(cx, y + TILE * .16); ctx.lineTo(cx - TILE * .16, y + TILE * .52);
  ctx.lineTo(cx, y + TILE * .46); ctx.lineTo(cx + TILE * .16, y + TILE * .52); ctx.closePath(); ctx.fill();
}

function drawCity(x, y, color) {
  const pad = TILE * .2;
  ctx.fillStyle = color;
  ctx.fillRect(x + pad, y + TILE * .34, TILE - pad * 2, TILE * .42);
  ctx.fillRect(x + TILE * .28, y + TILE * .22, TILE * .14, TILE * .22);
  ctx.fillRect(x + TILE * .58, y + TILE * .17, TILE * .14, TILE * .27);
  ctx.fillStyle = 'rgba(10,14,20,.72)';
  ctx.fillRect(x + TILE * .43, y + TILE * .55, TILE * .14, TILE * .21);
}

function drawGeneral(x, y, color) {
  const cx = x + TILE / 2;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(x + TILE * .18, y + TILE * .27); ctx.lineTo(x + TILE * .34, y + TILE * .43);
  ctx.lineTo(x + TILE * .5, y + TILE * .25); ctx.lineTo(x + TILE * .66, y + TILE * .43);
  ctx.lineTo(x + TILE * .82, y + TILE * .27); ctx.lineTo(x + TILE * .72, y + TILE * .68);
  ctx.lineTo(x + TILE * .28, y + TILE * .68); ctx.closePath(); ctx.fill();
  ctx.fillStyle = 'rgba(10,14,20,.75)'; ctx.fillRect(cx - TILE * .16, y + TILE * .52, TILE * .32, TILE * .13);
}

function centerOf(i) {
  const G = S.game;
  return [(i % G.w) * TILE + TILE / 2, ((i / G.w) | 0) * TILE + TILE / 2];
}

function drawArrow(from, to, headScale) {
  const [x1, y1] = centerOf(from);
  const [x2, y2] = centerOf(to);
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len = Math.hypot(dx, dy) || 1;
  const pad = TILE * 0.22;
  const sx = x1 + (dx / len) * pad;
  const sy = y1 + (dy / len) * pad;
  const ex = x2 - (dx / len) * pad;
  const ey = y2 - (dy / len) * pad;
  ctx.beginPath();
  ctx.moveTo(sx, sy);
  ctx.lineTo(ex, ey);
  ctx.stroke();
  const a = Math.atan2(dy, dx);
  const s = TILE * headScale;
  ctx.beginPath();
  ctx.moveTo(ex, ey);
  ctx.lineTo(ex - s * Math.cos(a - 0.5), ey - s * Math.sin(a - 0.5));
  ctx.lineTo(ex - s * Math.cos(a + 0.5), ey - s * Math.sin(a + 0.5));
  ctx.closePath();
  ctx.fill();
}

/* ---------- 计分板 / 顶栏 / 警报 ---------- */

function renderScore() {
  const G = S.game;
  const v = G && G.tick;
  if (!G || !v) return;
  const box = $('scoreList');
  box.innerHTML = '';
  const rows = G.players
    .map((p, i) => ({ i, ...p, ...v.scores[i], alive: v.alive[i] }))
    .sort((a, b) => b.army - a.army);
  for (const r of rows) {
    const div = document.createElement('div');
    div.className = 'score-row' + (r.i === v.you ? ' me' : '') + (r.alive ? '' : ' dead');
    const dot = document.createElement('span');
    dot.className = 'pcolor';
    dot.style.background = COLORS[r.i % 8];
    div.appendChild(dot);
    const nm = document.createElement('span');
    nm.className = 'sname';
    nm.textContent = (r.alive ? '' : '💀 ') + r.name + (r.isBot ? ' 🤖' : '') + (r.i === v.you ? '（你）' : '');
    div.appendChild(nm);
    const nums = document.createElement('span');
    nums.className = 'nums';
    nums.innerHTML = `⚔️ <b>${r.army}</b> 🟫 <b>${r.land}</b>`;
    div.appendChild(nums);
    box.appendChild(div);
  }
}

function renderTurnBar() {
  const G = S.game;
  const v = G && G.tick;
  if (!G) return;
  $('turnInfo').textContent = v ? `回合 ${v.turn}` : '回合 -';
  if (v) {
    const next = 25 - (v.turn % 25);
    $('roundInfo').textContent = `🌾 全体+1：${next}回合后`;
    $('queueInfo').textContent = v.you >= 0 && v.alive[v.you] ? `📋 队列 ${displayQueue().length}` : '';
    const badge = $('roleBadge');
    if (v.you < 0) {
      badge.textContent = '👁 观战中';
      badge.className = '';
    } else if (!v.alive[v.you]) {
      badge.textContent = '💀 已阵亡 · 观战中';
      badge.className = '';
    } else {
      badge.textContent = '⚔️ 作战中';
      badge.className = 'me';
      badge.id = 'roleBadge';
    }
  }
}

function checkDanger(v) {
  const G = S.game;
  const banner = $('dangerBanner');
  let danger = false;
  if (v.you >= 0 && v.alive[v.you]) {
    let g = -1;
    for (let i = 0; i < v.terrain.length; i++) {
      if (v.terrain[i] === T_GENERAL && v.owner[i] === v.you) {
        g = i;
        break;
      }
    }
    if (g >= 0) {
      const gx = g % G.w;
      const gy = (g / G.w) | 0;
      outer: for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          if (Math.abs(dx) + Math.abs(dy) > 2 || (dx === 0 && dy === 0)) continue;
          const nx = gx + dx;
          const ny = gy + dy;
          if (nx < 0 || ny < 0 || nx >= G.w || ny >= G.h) continue;
          const o = v.owner[ny * G.w + nx];
          if (o >= 0 && o !== v.you) {
            danger = true;
            break outer;
          }
        }
      }
    }
  }
  banner.hidden = !danger;
  if (danger && !G.dangerWas) {
    const now = Date.now();
    if (now - G.lastDangerSfx > 6000) {
      G.lastDangerSfx = now;
      sfx.alarm();
      toast('⚠️ 将军受到威胁！', 'err');
    }
  }
  G.dangerWas = danger;
}

/* ---------- 棋盘交互 ---------- */

function tileAt(e) {
  const G = S.game;
  if (!G) return -1;
  const r = cv.getBoundingClientRect();
  const x = Math.floor(((e.clientX - r.left) / r.width) * G.w);
  const y = Math.floor(((e.clientY - r.top) / r.height) * G.h);
  if (x < 0 || y < 0 || x >= G.w || y >= G.h) return -1;
  return y * G.w + x;
}

cv.addEventListener('pointerdown', (e) => {
  const i = tileAt(e);
  if (i >= 0) onTile(i, e.shiftKey);
});
cv.addEventListener('mousemove', (e) => {
  const i = tileAt(e);
  if (i !== HOVER) {
    HOVER = i;
    renderBoard();
  }
});
cv.addEventListener('mouseleave', () => {
  HOVER = -1;
  renderBoard();
});

function onTile(i, shiftHalf) {
  const G = S.game;
  const v = G && G.tick;
  if (!G || !v || v.over) return;
  const you = v.you;
  if (you < 0 || !v.alive[you]) return;
  const half = G.half || shiftHalf;
  const q = displayQueue();

  // 队列空且选中格已失效 → 视为未选中
  if (!q.length && (G.selection < 0 || v.owner[G.selection] !== you)) {
    if (v.owner[i] === you && v.army[i] > 1) {
      G.selection = i;
      sfx.click();
      renderBoard();
    }
    return;
  }
  if (!q.length && G.selection < 0) {
    if (v.owner[i] === you && v.army[i] > 1) {
      G.selection = i;
      sfx.click();
      renderBoard();
    }
    return;
  }

  const tail = q.length ? q[q.length - 1].to : G.selection;
  if (i === tail) {
    if (!q.length) {
      G.selection = -1; // 再次点击取消选中
      renderBoard();
    }
    return;
  }
  const path = findPath(v, tail, i, G.w, G.h);
  if (path && path.length) {
    for (const s of path) sendMove(s.from, s.to, half, true);
    G.selection = i;
    sfx.move();
    renderBoard();
    renderTurnBar();
  } else if (v.owner[i] === you && v.army[i] > 1) {
    G.selection = i;
    sfx.click();
    renderBoard();
  }
}

function stepMove(dx, dy, shiftHalf) {
  const G = S.game;
  const v = G && G.tick;
  if (!G || !v || v.over) return;
  const you = v.you;
  if (you < 0 || !v.alive[you]) return;
  const q = displayQueue();
  let tail = q.length ? q[q.length - 1].to : G.selection;
  if (tail < 0 || v.owner[tail] !== you) {
    // 没有可用起点：选中将军
    for (let i = 0; i < v.terrain.length; i++) {
      if (v.terrain[i] === T_GENERAL && v.owner[i] === you) {
        G.selection = i;
        renderBoard();
        return;
      }
    }
    return;
  }
  const x = tail % G.w;
  const y = (tail / G.w) | 0;
  const nx = x + dx;
  const ny = y + dy;
  if (nx < 0 || ny < 0 || nx >= G.w || ny >= G.h) return;
  const to = ny * G.w + nx;
  if (v.terrain[to] === T_MOUNTAIN) return;
  sendMove(tail, to, G.half || shiftHalf, false);
  G.selection = to;
  sfx.move();
  renderBoard();
  renderTurnBar();
}

document.addEventListener('keydown', (e) => {
  if (S.screen !== 'game' || !S.game || S.modal) return;
  const tag = (e.target && e.target.tagName) || '';
  if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
  const dirs = {
    ArrowUp: [0, -1],
    w: [0, -1],
    W: [0, -1],
    ArrowDown: [0, 1],
    s: [0, 1],
    S: [0, 1],
    ArrowLeft: [-1, 0],
    a: [-1, 0],
    A: [-1, 0],
    ArrowRight: [1, 0],
    d: [1, 0],
    D: [1, 0],
  };
  if (dirs[e.key]) {
    e.preventDefault();
    stepMove(dirs[e.key][0], dirs[e.key][1], e.shiftKey);
  } else if (e.key === 'z' || e.key === 'Z') {
    doUndo();
  } else if (e.key === 'x' || e.key === 'X') {
    doClear();
  } else if (e.key === 'q' || e.key === 'Q') {
    toggleHalf();
  }
});

/* ================= 按钮绑定 ================= */

function bindUI() {
  $('addrBadge').textContent = `🔗 联机地址：http://${location.host}（发给同 WiFi 朋友）`;

  $('nameInput').value = S.name;
  $('nameInput').addEventListener('change', () => {
    const v = $('nameInput').value.trim().slice(0, 12);
    if (!v) {
      $('nameInput').value = S.name;
      return;
    }
    send({ t: 'setName', name: v });
  });

  $('soundBtn').textContent = S.muted ? '🔇' : '🔊';
  $('soundBtn').onclick = () => {
    S.muted = !S.muted;
    localStorage.setItem('lg_muted', S.muted ? '1' : '0');
    $('soundBtn').textContent = S.muted ? '🔇' : '🔊';
    if (!S.muted) sfx.coin();
  };
  $('helpBtn').onclick = showHelp;

  $('createBtn').onclick = () => {
    send({
      t: 'createRoom',
      roomName: $('roomNameInput').value.trim(),
      maxPlayers: Number($('maxPlayersSel').value),
      mapSize: $('mapSel').value,
      speed: $('speedSel').value,
    });
  };
  $('refreshBtn').onclick = () => send({ t: 'listRooms' });

  $('readyBtn').onclick = () => send({ t: 'toggleReady' });
  $('startBtn').onclick = () => send({ t: 'startGame' });
  $('addBotBtn').onclick = () => send({ t: 'addBot' });
  $('leaveRoomBtn').onclick = () => send({ t: 'leaveRoom' });

  $('roomChatSend').onclick = () => sendChat('roomChatInput');
  $('roomChatInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') sendChat('roomChatInput');
  });
  $('gameChatSend').onclick = () => sendChat('gameChatInput');
  $('gameChatInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') sendChat('gameChatInput');
  });

  $('halfBtn').onclick = toggleHalf;
  $('undoBtn').onclick = doUndo;
  $('clearBtn').onclick = doClear;
  $('surrenderBtn').onclick = () => {
    if (confirm('确定要投降吗？你的土地将变为中立。')) send({ t: 'surrender' });
  };
  $('leaveGameBtn').onclick = () => {
    if (confirm('离开后将由电脑托管（同一浏览器重进可回来），确定吗？')) send({ t: 'leaveRoom' });
  };
}

function showHelp() {
  showModal(
    '📖 玩法说明',
    `<div class="help-body">
    🎯 <b>目标</b>：扩张地盘，抓住所有敌方将军（♛），活到最后！<br>
    🏙️ <b>城市（◆）</b>：有 30~45 守军，攻下后每回合 +1 兵。<br>
    🌾 <b>收成</b>：每 25 回合，所有己方土地 +1 兵。<br>
    🌫️ <b>迷雾</b>：只能看到己方土地及周边，城市视野更远。<br>
    ⚔️ <b>拼兵</b>：进攻拼兵力，剩得多的一方占领。<br><br>
    🖱️ <b>操作</b>：点己方格选中 → 点目标行军（自动寻路，可穿迷雾）；<br>
    ⌨️ <kbd>WASD</kbd>/<kbd>方向键</kbd> 连续行军 · <kbd>Z</kbd> 撤销 · <kbd>X</kbd> 清空 · <kbd>Q</kbd>/Shift 半数出兵。<br><br>
    🔗 <b>联机</b>：同一 WiFi 下，朋友浏览器打开顶部绿字地址即可加入，无需公网。<br>
    🤖 <b>人不够</b>：房主可加电脑；掉线自动托管，重进即可回来。
    </div>`,
    [{ label: '知道了', primary: true, fn: hideModal }]
  );
}

/* ================= 启动 ================= */

bindUI();
connect();
