'use strict';

/**
 * LAN-generals 服务端
 * - HTTP：托管前端静态页面（局域网内浏览器直连，无需公网）
 * - WebSocket：大厅 / 房间 / 对局实时同步
 *
 * 启动：npm start（默认端口 3000，可用 PORT 环境变量覆盖）
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const WebSocket = require('ws');
const { Game } = require('./lib/game');
const { planBotMoves } = require('./lib/bot');

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC = path.join(__dirname, 'public');

const SPEEDS = { slow: 1000, normal: 500, fast: 250 };
const SPEED_NAMES = { slow: '慢速', normal: '标准', fast: '快速' };
const MAP_SIZES = { small: 15, medium: 20, large: 26 };
const MAP_NAMES = { small: '小', medium: '中', large: '大', adaptive: '自适应' };
const MAX_SPECTATORS = 12;
const BOT_NAMES = ['曹操', '诸葛亮', '司马懿', '周瑜', '吕布', '赵云', '关羽', '张飞'];

function mapSizeFor(opt, n) {
  if (MAP_SIZES[opt]) return MAP_SIZES[opt];
  return Math.min(30, Math.max(12, 12 + 2 * n)); // 自适应
}

function uid(prefix) {
  return prefix + crypto.randomBytes(4).toString('hex').toUpperCase();
}

function cleanName(s, fallback) {
  s = String(s || '').trim().slice(0, 12);
  return s || fallback;
}

// ---------------- 状态 ----------------

/** clientId -> { id, ws, name, token, roomId, connected, lastChatAt } */
const clients = new Map();
/** token -> clientId */
const tokens = new Map();
/** roomId -> room */
const rooms = new Map();

// ---------------- 推送 ----------------

function send(client, msg) {
  if (!client || !client.connected || !client.ws || client.ws.readyState !== WebSocket.OPEN) return;
  try {
    client.ws.send(JSON.stringify(msg));
  } catch (e) {
    /* ignore */
  }
}

function publicRoom(room) {
  return {
    id: room.id,
    name: room.name,
    hostId: room.hostId,
    status: room.status,
    config: room.config,
    players: room.players.map((p) => ({
      slot: p.slot,
      clientId: p.clientId,
      name: p.name,
      isBot: p.isBot,
      ready: p.ready,
      connected: p.connected,
    })),
    spectators: [...room.spectators]
      .map((cid) => clients.get(cid))
      .filter(Boolean)
      .map((c) => ({ clientId: c.id, name: c.name })),
    turn: room.game ? room.game.turn : 0,
  };
}

function roomMembers(room) {
  const out = [];
  for (const p of room.players) {
    if (!p.isBot && p.clientId) {
      const c = clients.get(p.clientId);
      if (c) out.push(c);
    }
  }
  for (const cid of room.spectators) {
    const c = clients.get(cid);
    if (c) out.push(c);
  }
  return out;
}

function broadcastRoom(room) {
  const msg = { t: 'room', room: publicRoom(room) };
  for (const c of roomMembers(room)) send(c, msg);
}

function broadcastLobby() {
  for (const c of clients.values()) {
    if (!c.connected || c.roomId) continue;
    // 每人一份列表：标出自己是否有可重回的席位
    const list = [...rooms.values()].map((r) => ({
      id: r.id,
      name: r.name,
      status: r.status,
      players: r.players.length,
      maxPlayers: r.config.maxPlayers,
      mapName: MAP_NAMES[r.config.mapSize] || '自适应',
      speedName: SPEED_NAMES[r.config.speed] || '标准',
      turn: r.game ? r.game.turn : 0,
      rejoin:
        r.status === 'playing' &&
        r.players.some((p) => !p.isBot && p.clientId === c.id && !p.connected),
    }));
    send(c, { t: 'lobby', rooms: list });
  }
}

function chatToRoom(room, from, text, sys = false) {
  const msg = { t: 'chat', from, text: String(text).slice(0, 200), sys, ts: Date.now() };
  room.chat.push(msg);
  if (room.chat.length > 100) room.chat.shift();
  for (const c of roomMembers(room)) send(c, msg);
}

function gameStartPayload(room, slot, spectator) {
  return {
    t: 'gameStart',
    roomId: room.id,
    you: spectator ? -1 : slot,
    w: room.game.w,
    h: room.game.h,
    speed: room.config.speed,
    speedMs: SPEEDS[room.config.speed],
    players: room.game.players.map((p) => ({ name: p.name, isBot: p.isBot })),
  };
}

/** 向房间内所有人推送当前战况 */
function broadcastTick(room) {
  if (!room.game) return;
  for (const p of room.players) {
    if (p.isBot || !p.clientId) continue;
    const c = clients.get(p.clientId);
    if (!c || !c.connected) continue;
    const gp = room.game.players[p.slot];
    const view = gp.alive ? room.game.viewFor(p.slot) : room.game.fullView();
    send(c, { t: 'tick', roomId: room.id, you: p.slot, ...view });
  }
  const full = room.game.fullView();
  for (const cid of room.spectators) {
    const c = clients.get(cid);
    if (c && c.connected) send(c, { t: 'tick', roomId: room.id, you: -1, ...full });
  }
}

function broadcastGameOver(room) {
  if (!room.game) return;
  const msg = {
    t: 'gameOver',
    roomId: room.id,
    winner: room.game.winner,
    winnerName: room.game.winner >= 0 ? room.game.players[room.game.winner].name : null,
    turns: room.game.turn,
    scores: room.game.scores(),
    players: room.game.players.map((p) => ({ name: p.name, isBot: p.isBot })),
  };
  for (const c of roomMembers(room)) send(c, msg);
}

function stopTimer(room) {
  if (room.timer) {
    clearInterval(room.timer);
    room.timer = null;
  }
}

function finishIfOver(room) {
  if (room.game && room.game.over) {
    stopTimer(room);
    room.status = 'over';
    // 保持准备状态：人都在，直接点「再来一局」即可
    broadcastTick(room);
    broadcastGameOver(room);
    broadcastRoom(room);
    broadcastLobby();
    return true;
  }
  return false;
}

// ---------------- 房间操作 ----------------

function getRoomClientSlot(room, clientId) {
  const p = room.players.find((q) => !q.isBot && q.clientId === clientId);
  return p ? p.slot : -1;
}

function isHost(room, clientId) {
  return room.hostId === clientId;
}

function migrateHost(room) {
  const human = room.players.find((p) => !p.isBot && p.connected);
  room.hostId = human ? human.clientId : null;
  if (human) human.ready = true;
}

/** 房主空缺时（全员掉线后回来），由回归者接任 */
function ensureHost(room, client) {
  if (!room.hostId) {
    room.hostId = client.id;
    const p = room.players.find((q) => !q.isBot && q.clientId === client.id);
    if (p) p.ready = true;
  }
}

function connectedHumans(room) {
  let n = 0;
  for (const p of room.players) {
    if (!p.isBot && p.connected) n++;
  }
  for (const cid of room.spectators) {
    const c = clients.get(cid);
    if (c && c.connected) n++;
  }
  return n;
}

function destroyRoom(room) {
  stopTimer(room);
  for (const c of roomMembers(room)) {
    if (c.roomId === room.id) {
      c.roomId = null;
      send(c, { t: 'leftRoom', roomId: room.id });
    }
  }
  rooms.delete(room.id);
  broadcastLobby();
}

function leaveRoom(client, announce = true) {
  const room = rooms.get(client.roomId);
  if (!room) {
    client.roomId = null;
    return;
  }
  client.roomId = null;
  room.spectators.delete(client.id);
  const slot = getRoomClientSlot(room, client.id);

  if (slot >= 0) {
    const p = room.players[slot];
    if (room.status === 'playing' && room.game) {
      // 对局中离开：保留席位，转托管，可重连回来
      p.connected = false;
      room.game.players[slot].connected = false;
      if (announce) chatToRoom(room, '', `${p.name} 断开连接，转为托管`, true);
    } else {
      room.players.splice(slot, 1);
      room.players.forEach((q, i) => (q.slot = i));
      if (announce) chatToRoom(room, '', `${p.name} 离开了房间`, true);
    }
  }

  if (room.hostId === client.id) migrateHost(room);

  if (connectedHumans(room) === 0) {
    if (room.status !== 'playing') {
      destroyRoom(room);
      send(client, { t: 'leftRoom', roomId: room.id });
      return;
    }
    room.emptySince = Date.now();
  }

  send(client, { t: 'leftRoom', roomId: room.id });
  broadcastRoom(room);
  broadcastLobby();
}

function startGame(room) {
  const humans = room.players.filter((p) => !p.isBot);
  if (room.players.length < 2) return { ok: false, reason: '至少需要 2 名玩家（含电脑）' };
  if (humans.some((p) => p.connected && p.clientId !== room.hostId && !p.ready)) {
    return { ok: false, reason: '还有玩家未准备' };
  }
  stopTimer(room);
  const n = room.players.length;
  const size = mapSizeFor(room.config.mapSize, n);
  room.game = new Game({
    w: size,
    h: size,
    players: room.players.map((p) => ({ name: p.name, isBot: p.isBot, connected: p.connected })),
    mountainDensity: 0.16,
    cityCount: 2 + n,
    maxTurns: 1500,
  });
  room.status = 'playing';
  room.emptySince = 0;

  for (const c of roomMembers(room)) {
    const slot = getRoomClientSlot(room, c.id);
    const spectator = slot < 0;
    send(c, gameStartPayload(room, slot, spectator));
    // 聊天记录同步
    for (const m of room.chat.slice(-30)) send(c, m);
  }
  chatToRoom(room, '', `对局开始！${size}x${size} 地图，${SPEED_NAMES[room.config.speed]}速度`, true);
  broadcastTick(room);
  broadcastRoom(room);
  broadcastLobby();

  room.timer = setInterval(() => {
    try {
      room.game.step(planBotMoves);
      if (!finishIfOver(room)) broadcastTick(room);
    } catch (e) {
      console.error('tick error:', e);
    }
  }, SPEEDS[room.config.speed] || 500);
  return { ok: true };
}

// ---------------- 消息处理 ----------------

function handleMessage(client, raw) {
  let msg;
  try {
    msg = JSON.parse(raw);
  } catch (e) {
    return;
  }
  if (!msg || typeof msg.t !== 'string') return;
  const room = client.roomId ? rooms.get(client.roomId) : null;

  switch (msg.t) {
    case 'setName': {
      client.name = cleanName(msg.name, client.name);
      send(client, { t: 'me', clientId: client.id, name: client.name });
      if (room) {
        const slot = getRoomClientSlot(room, client.id);
        if (slot >= 0) {
          room.players[slot].name = client.name;
          if (room.game) room.game.players[slot].name = client.name;
          broadcastRoom(room);
        }
      }
      break;
    }

    case 'createRoom': {
      if (room) leaveRoom(client, false);
      const maxPlayers = Math.min(8, Math.max(2, Number(msg.maxPlayers) || 4));
      const mapSize = ['small', 'medium', 'large', 'adaptive'].includes(msg.mapSize)
        ? msg.mapSize
        : 'adaptive';
      const speed = SPEEDS[msg.speed] ? msg.speed : 'normal';
      const r = {
        id: uid('R'),
        name: cleanName(msg.roomName, `${client.name}的房间`).slice(0, 20),
        hostId: client.id,
        status: 'waiting',
        config: { maxPlayers, mapSize, speed },
        players: [
          { slot: 0, clientId: client.id, name: client.name, isBot: false, ready: true, connected: true },
        ],
        spectators: new Set(),
        game: null,
        timer: null,
        chat: [],
        emptySince: 0,
      };
      rooms.set(r.id, r);
      client.roomId = r.id;
      chatToRoom(r, '', `${client.name} 创建了房间`, true);
      broadcastRoom(r);
      broadcastLobby();
      break;
    }

    case 'joinRoom': {
      const r = rooms.get(msg.roomId);
      if (!r) {
        send(client, { t: 'error', msg: '房间不存在' });
        break;
      }
      if (room && room.id === r.id) {
        send(client, { t: 'room', room: publicRoom(r) });
        break;
      }
      if (room) leaveRoom(client, false);
      const wantSpectate = !!msg.asSpectator;
      const rejoinSlot = r.players.findIndex(
        (p) => !p.isBot && p.clientId === client.id && !p.connected
      );
      if (rejoinSlot >= 0 && !wantSpectate) {
        // 断线重连回原席位
        const p = r.players[rejoinSlot];
        p.connected = true;
        p.name = client.name;
        if (r.game) {
          r.game.players[rejoinSlot].connected = true;
          r.game.players[rejoinSlot].name = client.name;
        }
        client.roomId = r.id;
        ensureHost(r, client);
        chatToRoom(r, '', `${client.name} 回来了！`, true);
        send(client, gameStartPayload(r, rejoinSlot, false));
        const gp = r.game.players[rejoinSlot];
        const view = gp.alive ? r.game.viewFor(rejoinSlot) : r.game.fullView();
        send(client, { t: 'tick', roomId: r.id, you: rejoinSlot, ...view });
        for (const m of r.chat.slice(-30)) send(client, m);
        broadcastRoom(r);
      } else if (r.status === 'waiting' && !wantSpectate && r.players.length < r.config.maxPlayers) {
        const slot = r.players.length;
        r.players.push({
          slot,
          clientId: client.id,
          name: client.name,
          isBot: false,
          ready: false,
          connected: true,
        });
        client.roomId = r.id;
        ensureHost(r, client);
        chatToRoom(r, '', `${client.name} 加入了房间`, true);
        for (const m of r.chat.slice(-30)) send(client, m);
        broadcastRoom(r);
        broadcastLobby();
      } else {
        // 对局中 / 房间已满 / 主动观战 → 观战席
        if (r.spectators.size >= MAX_SPECTATORS) {
          send(client, { t: 'error', msg: '观战席已满' });
          break;
        }
        r.spectators.add(client.id);
        client.roomId = r.id;
        ensureHost(r, client);
        chatToRoom(r, '', `${client.name} 开始观战`, true);
        for (const m of r.chat.slice(-30)) send(client, m);
        if (r.status === 'playing' && r.game) {
          send(client, gameStartPayload(r, -1, true));
          send(client, { t: 'tick', roomId: r.id, you: -1, ...r.game.fullView() });
        }
        broadcastRoom(r);
      }
      break;
    }

    case 'leaveRoom': {
      if (room) leaveRoom(client);
      break;
    }

    case 'toggleReady': {
      if (!room || room.status !== 'waiting') break;
      const slot = getRoomClientSlot(room, client.id);
      if (slot < 0 || isHost(room, client.id)) break;
      room.players[slot].ready = !room.players[slot].ready;
      broadcastRoom(room);
      break;
    }

    case 'addBot': {
      if (!room || !isHost(room, client.id)) break;
      if (room.status !== 'waiting' && room.status !== 'over') break;
      if (room.players.length >= room.config.maxPlayers) {
        send(client, { t: 'error', msg: '房间已满' });
        break;
      }
      const used = new Set(room.players.map((p) => p.name));
      const name = BOT_NAMES.find((b) => !used.has(b)) || `电脑${room.players.length + 1}`;
      room.players.push({
        slot: room.players.length,
        clientId: null,
        name,
        isBot: true,
        ready: true,
        connected: true,
      });
      chatToRoom(room, '', `${name}（电脑）加入了房间`, true);
      broadcastRoom(room);
      broadcastLobby();
      break;
    }

    case 'removeBot': {
      if (!room || !isHost(room, client.id)) break;
      if (room.status !== 'waiting' && room.status !== 'over') break;
      const idx = room.players.findIndex((p) => p.isBot && p.slot === Number(msg.slot));
      if (idx >= 0) {
        const [rm] = room.players.splice(idx, 1);
        room.players.forEach((q, i) => (q.slot = i));
        chatToRoom(room, '', `${rm.name}（电脑）被移出房间`, true);
        broadcastRoom(room);
        broadcastLobby();
      }
      break;
    }

    case 'startGame': {
      if (!room || !isHost(room, client.id)) break;
      if (room.status === 'playing') break;
      const r = startGame(room);
      if (!r.ok) send(client, { t: 'error', msg: r.reason });
      break;
    }

    case 'move': {
      if (!room || !room.game || room.status !== 'playing') break;
      const slot = getRoomClientSlot(room, client.id);
      if (slot < 0) break;
      const from = Number(msg.from);
      const to = Number(msg.to);
      const r = room.game.queueMove(slot, from, to, !!msg.half);
      send(client, { t: 'ackMove', ok: r.ok, reason: r.reason || '', from, to });
      break;
    }

    case 'undoMove': {
      if (!room || !room.game || room.status !== 'playing') break;
      const slot = getRoomClientSlot(room, client.id);
      if (slot >= 0) room.game.undoMove(slot);
      break;
    }

    case 'clearMoves': {
      if (!room || !room.game || room.status !== 'playing') break;
      const slot = getRoomClientSlot(room, client.id);
      if (slot >= 0) room.game.clearMoves(slot);
      break;
    }

    case 'surrender': {
      if (!room || !room.game || room.status !== 'playing') break;
      const slot = getRoomClientSlot(room, client.id);
      if (slot < 0) break;
      if (room.game.surrender(slot)) {
        chatToRoom(room, '', `${room.game.players[slot].name} 投降了`, true);
        if (!finishIfOver(room)) {
          broadcastTick(room);
          broadcastRoom(room);
        }
      }
      break;
    }

    case 'chat': {
      if (!room) break;
      const now = Date.now();
      if (now - (client.lastChatAt || 0) < 800) break;
      client.lastChatAt = now;
      const text = String(msg.text || '').trim().slice(0, 200);
      if (!text) break;
      chatToRoom(room, client.name, text);
      break;
    }

    case 'listRooms': {
      broadcastLobby();
      if (room) send(client, { t: 'room', room: publicRoom(room) });
      break;
    }

    default:
      break;
  }
}

// ---------------- HTTP 静态服务 ----------------

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml',
};

const httpServer = http.createServer((req, res) => {
  try {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405);
      res.end('Method Not Allowed');
      return;
    }
    let pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (pathname === '/') pathname = '/index.html';
    const file = path.normalize(path.join(PUBLIC, pathname));
    if (!file.startsWith(PUBLIC)) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }
    fs.stat(file, (err, stat) => {
      if (err || !stat.isFile()) {
        // 单页应用回退
        const fallback = path.join(PUBLIC, 'index.html');
        fs.readFile(fallback, (e2, data) => {
          if (e2) {
            res.writeHead(404);
            res.end('Not Found');
          } else {
            res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-cache' });
            res.end(data);
          }
        });
        return;
      }
      const ext = path.extname(file).toLowerCase();
      res.writeHead(200, {
        'Content-Type': MIME[ext] || 'application/octet-stream',
        'Cache-Control': 'no-cache',
      });
      if (req.method === 'HEAD') {
        res.end();
      } else {
        fs.createReadStream(file).pipe(res);
      }
    });
  } catch (e) {
    res.writeHead(500);
    res.end('Server Error');
  }
});

// ---------------- WebSocket ----------------

const wss = new WebSocket.Server({ server: httpServer });

wss.on('connection', (ws) => {
  let client = null;

  const helloTimeout = setTimeout(() => {
    try {
      ws.close();
    } catch (e) {
      /* ignore */
    }
  }, 8000);

  ws.on('message', (data) => {
    if (!client) {
      // 首包必须是 hello（可带 token 断线重连）
      let hello;
      try {
        hello = JSON.parse(data.toString());
      } catch (e) {
        return;
      }
      if (!hello || hello.t !== 'hello') return;
      clearTimeout(helloTimeout);

      const oldId = hello.token && tokens.get(hello.token);
      const old = oldId && clients.get(oldId);
      if (old && !old.connected) {
        client = old;
        client.ws = ws;
        client.connected = true;
        client.isAlive = true;
        if (hello.name) client.name = cleanName(hello.name, client.name);
      } else {
        const id = uid('C');
        const token = crypto.randomBytes(12).toString('hex');
        client = {
          id,
          ws,
          token,
          name: cleanName(hello.name, `玩家${Math.floor(1000 + Math.random() * 9000)}`),
          roomId: null,
          connected: true,
          isAlive: true,
          lastChatAt: 0,
        };
        clients.set(id, client);
        tokens.set(token, id);
      }
      ws._clientId = client.id;
      send(client, { t: 'welcome', clientId: client.id, token: client.token, name: client.name });

      // 重连恢复：回到原房间
      const room = client.roomId && rooms.get(client.roomId);
      if (room) {
        ensureHost(room, client);
        const slot = getRoomClientSlot(room, client.id);
        if (slot >= 0) {
          const p = room.players[slot];
          const wasOut = !p.connected;
          p.connected = true;
          if (room.game) room.game.players[slot].connected = true;
          if (room.status === 'playing' && room.game) {
            if (wasOut) chatToRoom(room, '', `${client.name} 重新连接！`, true);
            send(client, gameStartPayload(room, slot, false));
            const gp = room.game.players[slot];
            const view = gp.alive ? room.game.viewFor(slot) : room.game.fullView();
            send(client, { t: 'tick', roomId: room.id, you: slot, ...view });
          }
        } else if (room.spectators.has(client.id) && room.status === 'playing' && room.game) {
          send(client, gameStartPayload(room, -1, true));
          send(client, { t: 'tick', roomId: room.id, you: -1, ...room.game.fullView() });
        }
        for (const m of room.chat.slice(-30)) send(client, m);
        broadcastRoom(room);
      } else {
        client.roomId = null;
        broadcastLobby();
      }
      return;
    }
    handleMessage(client, data.toString());
  });

  ws.on('pong', () => {
    if (client) client.isAlive = true;
  });

  ws.on('close', () => {
    clearTimeout(helloTimeout);
    if (!client) return;
    client.connected = false;
    client.ws = null;
    const room = client.roomId && rooms.get(client.roomId);
    if (room) {
      const slot = getRoomClientSlot(room, client.id);
      if (slot >= 0) {
        const p = room.players[slot];
        p.connected = false;
        if (room.game && room.status === 'playing') {
          room.game.players[slot].connected = false; // 托管
          chatToRoom(room, '', `${p.name} 断开连接，转为托管`, true);
        }
        if (room.hostId === client.id) migrateHost(room);
      }
      if (connectedHumans(room) === 0) {
        if (room.status !== 'playing') {
          destroyRoom(room);
          return;
        }
        room.emptySince = Date.now();
      }
      broadcastRoom(room);
      broadcastLobby();
    }
  });

  ws.on('error', () => {
    try {
      ws.close();
    } catch (e) {
      /* ignore */
    }
  });
});

// 心跳
setInterval(() => {
  for (const c of clients.values()) {
    if (!c.connected || !c.ws) continue;
    if (c.isAlive === false) {
      try {
        c.ws.terminate();
      } catch (e) {
        /* ignore */
      }
      continue;
    }
    c.isAlive = false;
    try {
      c.ws.ping();
    } catch (e) {
      /* ignore */
    }
  }
}, 30000);

// 房间清扫：长时间没人的房间回收
setInterval(() => {
  const now = Date.now();
  for (const room of [...rooms.values()]) {
    if (connectedHumans(room) > 0) {
      room.emptySince = 0;
      continue;
    }
    if (room.status === 'playing') {
      // 没人看的对局：超过 10 分钟还没打完就强制结束回收
      if (room.emptySince && now - room.emptySince > 10 * 60 * 1000) {
        destroyRoom(room);
      }
    } else {
      if (!room.emptySince) room.emptySince = now;
      if (now - room.emptySince > 60 * 1000) destroyRoom(room);
    }
  }
}, 30000);

// ---------------- 启动 ----------------

function lanAddresses() {
  const out = [];
  const ifs = os.networkInterfaces();
  for (const name of Object.keys(ifs)) {
    for (const info of ifs[name]) {
      if (info.family === 'IPv4' && !info.internal) out.push(info.address);
    }
  }
  return out;
}

httpServer.listen(PORT, '0.0.0.0', () => {
  console.log('');
  console.log('  ⚔️  LAN-generals 已启动！');
  console.log('');
  console.log(`  本机游玩：  http://localhost:${PORT}`);
  const addrs = lanAddresses();
  if (addrs.length) {
    console.log('  局域网联机（把下面地址发给同一 WiFi 的朋友）：');
    for (const a of addrs) console.log(`    👉 http://${a}:${PORT}`);
  } else {
    console.log('  未检测到局域网 IP（本机仍可玩，检查网络后重启即可联机）');
  }
  console.log('');
  console.log('  按 Ctrl+C 停止服务');
  console.log('');
});

process.on('SIGINT', () => {
  console.log('\n正在关闭…');
  for (const room of rooms.values()) stopTimer(room);
  process.exit(0);
});
