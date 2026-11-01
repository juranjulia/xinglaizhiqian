// 调和之夜 —— 3~6 人身份推理卡牌游戏联机服务器（零依赖）
// 运行：node server.js   （默认端口 3000，可用环境变量 PORT 修改）
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT) || 3000;
const ROOM_TTL = 6 * 3600 * 1000;
const HTML = fs.readFileSync(path.join(__dirname, 'index.html'));

// ---------------- 卡牌数据 ----------------
const ROLES = {
  alien:      { name: '外星人',   value: -1, pri: 1 },
  infected:   { name: '感染者',   value: 0,  pri: 2 },
  culprit:    { name: '犯人',     value: 0,  pri: 3 },
  accomplice: { name: '共犯',     value: 0,  pri: 3 },
  president:  { name: '学生会长', value: 3,  pri: 4 },
  classrep:   { name: '班长',     value: 2,  pri: 4 },
  honor:      { name: '优等生',   value: 2,  pri: 4 },
  discipline: { name: '风纪委员', value: 1,  pri: 4 },
  nurse:      { name: '保健委员', value: 1,  pri: 4 },
  librarian:  { name: '图书委员', value: 1,  pri: 4 },
  ojou:       { name: '大小姐',   value: 1,  pri: 4 },
  press:      { name: '新闻部',   value: 1,  pri: 4 },
  homegoer:   { name: '归宅部',   value: 0,  pri: 5 },
};
const BASE = { alien: 1, infected: 1, culprit: 1, accomplice: 1, president: 1, classrep: 2, honor: 2,
  discipline: 2, nurse: 2, librarian: 2, ojou: 3, press: 3, homegoer: 3 };
const HAND = { 3: 6, 4: 6, 5: 5, 6: 4 };
const TARGET = { 3: 9, 4: 8, 5: 7, 6: 6 };

function deckCounts(n) {
  const c = { ...BASE };
  if (n === 3) Object.assign(c, { accomplice: 0, honor: 1, discipline: 1, ojou: 2, press: 2, homegoer: 2 });
  if (n === 5) c.librarian = 3;
  return c;
}

// ---------------- 工具 ----------------
const rid = () => crypto.randomBytes(8).toString('hex');
const shuffle = a => { for (let i = a.length - 1; i > 0; i--) { const j = crypto.randomInt(i + 1); [a[i], a[j]] = [a[j], a[i]]; } return a; };
class GameError extends Error {}
const fail = m => { throw new GameError(m); };

const rooms = new Map();
function newCode() { let c; do { c = String(1000 + crypto.randomInt(9000)); } while (rooms.has(c)); return c; }
function cleanName(n) { n = String(n || '').trim().slice(0, 10); return n || '玩家'; }

function newPlayer(name) {
  return { id: rid(), token: rid(), name: cleanName(name), clients: new Set(),
           hand: [], front: [], accused: [], infectArm: false, notices: [] };
}

const roleOf = (room, cid) => room.cards[cid];
const nameOf = (room, cid) => ROLES[room.cards[cid]].name;
const pById = (room, id) => room.players.find(p => p.id === id);
const cur = room => room.players[room.turn];

function log(room, text) {
  room.log.push({ n: ++room.seq, text });
  if (room.log.length > 200) room.log.shift();
}
function notify(p, room, text) {
  p.notices.push({ n: ++room.seq, text });
  if (p.notices.length > 40) p.notices.shift();
}
// 标准模式：只剩 1 张手牌的玩家被锁定，其手牌不能被移动；浑沌模式：不锁定
function movable(room, p) { return room.mode === 'chaos' ? p.hand.length >= 1 : p.hand.length >= 2; }

// ---------------- 游戏流程 ----------------
function startGame(room) {
  const n = room.players.length;
  room.cards = {};
  const deck = [];
  let k = 0;
  for (const [role, cnt] of Object.entries(deckCounts(n)))
    for (let i = 0; i < cnt; i++) { const id = 'c' + (++k); room.cards[id] = role; deck.push(id); }
  shuffle(deck);
  const hs = HAND[n];
  room.players.forEach((p, i) => {
    p.hand = deck.slice(i * hs, (i + 1) * hs);
    p.front = []; p.accused = []; p.infectArm = false; p.notices = [];
  });
  room.pile = [];
  room.pending = null;
  room.result = null;
  room.log = [];
  room.phase = 'play';
  room.target = TARGET[n];
  room.turn = Math.max(0, room.players.findIndex(p => p.hand.some(c => room.cards[c] === 'president')));
  log(room, `游戏开始！${n} 人局，每人 ${hs} 张手牌，调和目标值 ${room.target}。${room.mode === 'chaos' ? '【浑沌模式】' : ''}`);
  log(room, `${cur(room).name} 持有【学生会长】，作为起始玩家。`);
  beginTurn(room);
}

const allDone = room => room.players.every(p => p.hand.length <= 1);

function beginTurn(room) {
  for (let guard = 0; guard < 50; guard++) {
    if (allDone(room)) return endGame(room);
    const p = cur(room);
    if (p.infectArm) {
      p.infectArm = false;
      const still = p.front.some(c => room.cards[c] === 'infected');
      if (still && room.pile.length) { room.pending = { type: 'infect', actor: p.id }; return; }
    }
    if (p.hand.length >= 2) return; // 等待该玩家出牌
    log(room, `${p.name} 只剩最后一张手牌，回合跳过。`);
    room.turn = (room.turn + 1) % room.players.length;
  }
}

function nextTurn(room) {
  room.pending = null;
  if (allDone(room)) return endGame(room);
  room.turn = (room.turn + 1) % room.players.length;
  beginTurn(room);
}

function continueSameTurn(room) {
  room.pending = null;
  if (allDone(room)) return endGame(room);
  const p = cur(room);
  if (p.hand.length >= 2) return;
  log(room, `${p.name} 只剩最后一张手牌，回合跳过。`);
  nextTurn(room);
}

// ---------------- 出牌 ----------------
function play(room, p, a) {
  if (room.phase !== 'play') fail('游戏不在进行中');
  if (room.pending) fail('请先等待当前效果结算');
  if (cur(room) !== p) fail('还没轮到你');
  if (p.hand.length < 2) fail('最后一张手牌不能打出');
  const card = a.card;
  const idx = p.hand.indexOf(card);
  if (idx < 0) fail('你没有这张牌');
  const role = room.cards[card];
  if (role === 'culprit') fail('【犯人】无论正面还是反面都无法打出');

  if (a.how === 'blend') {
    p.hand.splice(idx, 1);
    room.pile.push(card);
    log(room, `${p.name} 将一张牌反面朝上放入调和区。（调和区现有 ${room.pile.length} 张）`);
    return nextTurn(room);
  }
  if (a.how === 'accuse') {
    const t = pById(room, a.target);
    if (!t || t === p) fail('请选择要质疑的其他玩家');
    p.hand.splice(idx, 1);
    t.accused.push({ card, by: p.id });
    log(room, `${p.name} 质疑了 ${t.name}，在 TA 面前放下一张反面牌。`);
    return nextTurn(room);
  }
  if (a.how !== 'skill') fail('未知的出牌方式');

  // 特技：先移出手牌放到面前，校验失败则还原
  p.hand.splice(idx, 1);
  p.front.push(card);
  try {
    skill(room, p, role, card, a);
  } catch (e) {
    p.front.pop();
    p.hand.splice(idx, 0, card);
    throw e;
  }
  if (!room.pending) nextTurn(room);
}

function skill(room, p, role, card, a) {
  const R = ROLES[role].name;
  const others = room.players.filter(x => x !== p);
  const target = () => { const t = pById(room, a.target); if (!t || t === p) fail('请选择一名其他玩家'); return t; };

  switch (role) {
    case 'alien':
    case 'president':
      log(room, `${p.name} 正面打出【${R}】，没有效果。`);
      return;

    case 'infected':
      p.infectArm = true;
      log(room, `${p.name} 正面打出【感染者】。若到 TA 下回合开始时这张牌还在面前，TA 可以从调和区拿走一张牌。`);
      return;

    case 'accomplice': {
      if (a.skip || !p.accused.length) {
        log(room, `${p.name} 正面打出【共犯】，没有转移质疑牌。`);
        return;
      }
      const i = Number(a.accused);
      if (!(i >= 0 && i < p.accused.length)) fail('请选择你面前的一张质疑牌');
      const t = target();
      const [moved] = p.accused.splice(i, 1);
      t.accused.push(moved);
      log(room, `${p.name} 正面打出【共犯】，把自己面前的一张质疑牌转移到了 ${t.name} 面前。`);
      return;
    }

    case 'librarian': {
      const val = c => ROLES[room.cards[c]].value;
      const list = room.pile.map((c, i) => `${i + 1}.【${nameOf(room, c)}】${val(c)}`).join('　');
      const sum = room.pile.reduce((s, c) => s + val(c), 0);
      const gap = room.target - sum;
      const status = gap > 0 ? `还差 ${gap} 就能调和成功` : `已经达到目标，现在结算的话调和成功`;
      notify(p, room, room.pile.length
        ? `【图书委员】调和区共 ${room.pile.length} 张（按放置顺序）：\n${list}\n目前调和值 ${sum} / 目标 ${room.target}，${status}。`
        : `【图书委员】调和区目前没有牌。目前调和值 0 / 目标 ${room.target}，还差 ${room.target} 就能调和成功。`);
      log(room, `${p.name} 正面打出【图书委员】，查看了调和区的所有牌。`);
      return;
    }

    case 'discipline': {
      const t = target();
      const list = t.hand.map(c => `【${nameOf(room, c)}】`).join(' ');
      notify(p, room, `【风纪委员】${t.name} 的手牌：${list || '（没有手牌）'}`);
      log(room, `${p.name} 正面打出【风纪委员】，查看了 ${t.name} 的全部手牌。`);
      return;
    }

    case 'honor': {
      const tongues = others.filter(x => x.hand.some(c => ['culprit', 'alien'].includes(room.cards[c])));
      notify(p, room, tongues.length
        ? `【优等生】伸出舌头的人：${tongues.map(x => x.name).join('、')}（犯人或外星人都会伸舌头）`
        : '【优等生】没有人伸出舌头。');
      log(room, `${p.name} 正面打出【优等生】：其他人闭上眼睛，持有【犯人】的人伸出舌头……${p.name} 看到了结果。`);
      return;
    }

    case 'nurse': {
      if (a.skip) { log(room, `${p.name} 正面打出【保健委员】，没有拿牌。`); return; }
      const owner = room.players.find(x => x !== p && x.front.includes(a.front));
      if (!owner) fail('请选择其他玩家面前一张正面朝上的牌');
      if (room.cards[a.front] === 'nurse') fail('不能拿走【保健委员】');
      owner.front.splice(owner.front.indexOf(a.front), 1);
      p.hand.push(a.front);
      log(room, `${p.name} 正面打出【保健委员】，拿走了 ${owner.name} 面前的【${nameOf(room, a.front)}】加入手牌。`);
      return;
    }

    case 'homegoer': {
      if (a.skip) { log(room, `${p.name} 正面打出【归宅部】，没有交换。`); return; }
      if (!room.pile.length) fail('调和区没有牌可以交换');
      if (!movable(room, p)) fail('打出后你只剩一张手牌，已被锁定，无法交换（可以选择不发动效果）');
      const hi = p.hand.indexOf(a.give);
      if (hi < 0) fail('请选择一张要交换出去的手牌');
      const pos = Number(a.pos);
      if (!(pos >= 0 && pos < room.pile.length)) fail('请选择调和区的位置');
      const got = room.pile[pos];
      room.pile[pos] = a.give;
      p.hand[hi] = got;
      notify(p, room, `【归宅部】你把【${nameOf(room, a.give)}】放进调和区第 ${pos + 1} 张，换回了【${nameOf(room, got)}】。`);
      log(room, `${p.name} 正面打出【归宅部】，用一张手牌换走了调和区的第 ${pos + 1} 张牌。`);
      return;
    }

    case 'classrep': {
      const t = target();
      if (!movable(room, p)) fail('打出后你只剩一张手牌，已被锁定，无法交换');
      if (!movable(room, t)) fail(`${t.name} 只剩最后一张手牌，已被锁定`);
      room.pending = { type: 'swap', actor: p.id, target: t.id, picks: {} };
      log(room, `${p.name} 正面打出【班长】，要和 ${t.name} 各选一张手牌交换。`);
      return;
    }

    case 'ojou': {
      const t = target();
      if (!movable(room, t)) fail(`${t.name} 只剩最后一张手牌，已被锁定`);
      const stolen = t.hand.splice(crypto.randomInt(t.hand.length), 1)[0];
      p.hand.push(stolen);
      room.pending = { type: 'ojou', actor: p.id, target: t.id, stolen };
      log(room, `${p.name} 正面打出【大小姐】，从 ${t.name} 手中随机抽走一张牌，正在挑一张还给 TA……`);
      return;
    }

    case 'press': {
      const parts = room.players.filter(x => movable(room, x)).map(x => x.id);
      if (parts.length < 2) { log(room, `${p.name} 正面打出【新闻部】，但能传牌的人不足两名，没有效果。`); return; }
      room.pending = { type: 'news', actor: p.id, parts, picks: {} };
      const skipped = room.players.filter(x => !parts.includes(x.id)).map(x => x.name);
      log(room, `${p.name} 正面打出【新闻部】：每个人选一张手牌，反面传给左边的玩家。${skipped.length ? `（${skipped.join('、')} 手牌已锁定，不参与）` : ''}`);
      return;
    }
  }
  fail('这张牌没有特技');
}

// ---------------- 等待中的效果 ----------------
function resolvePending(room, p, a) {
  const pd = room.pending;
  if (!pd) fail('现在没有需要你处理的效果');

  if (pd.type === 'infect') {
    if (p.id !== pd.actor) fail('不是你的操作');
    if (a.skip) { log(room, `${p.name} 没有发动【感染者】的效果。`); return continueSameTurn(room); }
    const pos = Number(a.pos);
    if (!(pos >= 0 && pos < room.pile.length)) fail('请选择调和区的位置');
    const [got] = room.pile.splice(pos, 1);
    p.hand.push(got);
    notify(p, room, `【感染者】你从调和区第 ${pos + 1} 张拿到了【${nameOf(room, got)}】。`);
    log(room, `【感染者】发动：${p.name} 从调和区拿走了第 ${pos + 1} 张牌。（调和区剩 ${room.pile.length} 张）`);
    return continueSameTurn(room);
  }

  if (pd.type === 'ojou') {
    if (p.id !== pd.actor) fail('不是你的操作');
    const hi = p.hand.indexOf(a.card);
    if (hi < 0) fail('请选择一张手牌还给对方');
    const t = pById(room, pd.target);
    p.hand.splice(hi, 1);
    t.hand.push(a.card);
    notify(p, room, `【大小姐】你从 ${t.name} 抽到了【${nameOf(room, pd.stolen)}】，还给 TA【${nameOf(room, a.card)}】。`);
    notify(t, room, `【大小姐】${p.name} 抽走了你的【${nameOf(room, pd.stolen)}】，还给你【${nameOf(room, a.card)}】。`);
    log(room, `${p.name} 还给 ${t.name} 一张牌。`);
    return nextTurn(room);
  }

  if (pd.type === 'swap' || pd.type === 'news') {
    const who = pd.type === 'swap' ? [pd.actor, pd.target] : pd.parts;
    if (!who.includes(p.id)) fail('这次不需要你选牌');
    if (pd.picks[p.id]) fail('你已经选好了');
    if (!p.hand.includes(a.card)) fail('请选择一张手牌');
    pd.picks[p.id] = a.card;
    if (!who.every(id => pd.picks[id])) return; // 继续等待其他人

    // 所有人选完，同时传递
    const ps = who.map(id => pById(room, id));
    ps.forEach(x => x.hand.splice(x.hand.indexOf(pd.picks[x.id]), 1));
    ps.forEach((x, i) => {
      const to = pd.type === 'swap' ? ps[1 - i] : ps[(i + 1) % ps.length];
      const from = pd.type === 'swap' ? ps[1 - i] : ps[(i - 1 + ps.length) % ps.length];
      to.hand.push(pd.picks[x.id]);
      notify(x, room, `【${pd.type === 'swap' ? '班长' : '新闻部'}】你交给 ${to.name}【${nameOf(room, pd.picks[x.id])}】，从 ${from.name} 拿到【${nameOf(room, pd.picks[from.id])}】。`);
    });
    log(room, pd.type === 'swap' ? `${ps[0].name} 和 ${ps[1].name} 交换了一张手牌。` : '大家都把一张手牌传给了左边的玩家。');
    return nextTurn(room);
  }
}

// ---------------- 胜负判定 ----------------
function endGame(room) {
  room.phase = 'end';
  room.pending = null;
  const val = c => ROLES[room.cards[c]].value;
  const sum = room.pile.reduce((s, c) => s + val(c), 0);
  const success = sum >= room.target;

  const rows = room.players.map(p => ({
    id: p.id, name: p.name, role: room.cards[p.hand[0]],
    accused: p.accused.map(x => room.cards[x.card]),
    accSum: p.accused.reduce((s, x) => s + val(x.card), 0),
  }));
  // 嫌疑值必须大于 0 且为全场最高才会被监禁；全场最高不大于 0 时没有人被监禁
  const max = Math.max(0, ...rows.map(r => r.accSum));
  rows.forEach(r => { r.imprisoned = max > 0 && r.accSum === max; });

  const has = role => rows.filter(r => r.role === role);
  let winners = [], level = 0, reason = '';
  const alien = has('alien').filter(r => r.imprisoned);
  if (alien.length) { winners = alien; level = 1; reason = '外星人被监禁，外星人获胜！'; }
  if (!level && !success && has('infected').length) { winners = has('infected'); level = 2; reason = '调和失败，感染者获胜！'; }
  if (!level) {
    const culprit = has('culprit').filter(r => !r.imprisoned);
    if (culprit.length) { winners = [...culprit, ...has('accomplice')]; level = 3; reason = '犯人逃过了监禁，犯人' + (has('accomplice').length ? '和共犯' : '') + '获胜！'; }
  }
  if (!level && success) {
    const st = rows.filter(r => ROLES[r.role].pri === 4);
    if (st.length) { winners = st; level = 4; reason = '调和成功，并且没有更优先的胜者，学生们获胜！'; }
  }
  if (!level && has('homegoer').length) { winners = has('homegoer'); level = 5; reason = '没有任何人获胜，归宅部获胜！'; }
  if (!level) reason = '没有任何人满足胜利条件，所有人都输了……';
  rows.forEach(r => { r.win = winners.includes(r); });

  room.result = { sum, target: room.target, success, pile: room.pile.map(c => room.cards[c]), rows, level, reason };
  log(room, `所有人都只剩一张手牌，进入胜负判定。${reason}`);
}

// ---------------- 状态下发（只给每人看自己该看的） ----------------
function stateFor(room, me) {
  const pd = room.pending;
  let pending = null;
  if (pd) {
    const waiting = pd.type === 'swap' ? [pd.actor, pd.target].filter(id => !pd.picks[id])
      : pd.type === 'news' ? pd.parts.filter(id => !pd.picks[id]) : [pd.actor];
    pending = { type: pd.type, actor: pd.actor, target: pd.target || null, waiting, needMe: waiting.includes(me.id) };
    if (pd.type === 'ojou' && me.id === pd.actor) pending.stolen = { id: pd.stolen, role: room.cards[pd.stolen] };
    if ((pd.type === 'swap' || pd.type === 'news') && pd.picks[me.id]) pending.myPick = room.cards[pd.picks[me.id]];
  }
  return {
    code: room.code, phase: room.phase, mode: room.mode, host: room.hostId, you: me.id,
    target: room.target || TARGET[room.players.length] || null,
    pileCount: room.pile ? room.pile.length : 0,
    turn: room.phase === 'play' ? cur(room).id : null,
    players: room.players.map(p => ({
      id: p.id, name: p.name, online: p.clients.size > 0,
      handCount: p.hand.length,
      front: p.front.map(c => ({ id: c, role: room.cards[c] })),
      accused: p.accused.map(x => ({ mine: x.by === me.id, role: x.by === me.id ? room.cards[x.card] : null })),
    })),
    hand: me.hand.map(c => ({ id: c, role: room.cards[c] })),
    myAccused: me.accused.length,
    pending,
    log: room.log.slice(-80),
    notices: me.notices,
    result: room.result,
  };
}

function broadcast(room) {
  room.touched = Date.now();
  for (const p of room.players) {
    const data = 'data: ' + JSON.stringify(stateFor(room, p)) + '\n\n';
    for (const res of p.clients) res.write(data);
  }
}

// ---------------- 房间操作 ----------------
function act(room, p, a) {
  switch (a.type) {
    case 'mode':
      if (room.phase !== 'lobby' || p.id !== room.hostId) fail('只有房主能修改');
      room.mode = a.mode === 'chaos' ? 'chaos' : 'standard';
      return;
    case 'start':
      if (p.id !== room.hostId) fail('只有房主能开始游戏');
      if (room.phase === 'play') fail('游戏已经开始');
      if (room.players.length < 3) fail('至少需要 3 名玩家');
      return startGame(room);
    case 'lobby':
      if (p.id !== room.hostId) fail('只有房主能操作');
      if (room.phase !== 'end') fail('游戏还没结束');
      room.phase = 'lobby'; room.result = null; room.log = [];
      room.players.forEach(x => { x.hand = []; x.front = []; x.accused = []; x.notices = []; });
      return;
    case 'leave':
      if (room.phase === 'play') fail('游戏进行中不能离开，请等本局结束');
      for (const res of p.clients) res.end();
      room.players = room.players.filter(x => x !== p);
      if (!room.players.length) { rooms.delete(room.code); return; }
      if (room.hostId === p.id) room.hostId = room.players[0].id;
      return;
    case 'play': return play(room, p, a);
    case 'resolve': return resolvePending(room, p, a);
  }
  fail('未知操作');
}

// ---------------- HTTP ----------------
function readBody(req) {
  return new Promise((resolve, reject) => {
    let d = '';
    req.on('data', c => { d += c; if (d.length > 10000) { req.destroy(); reject(); } });
    req.on('end', () => { try { resolve(JSON.parse(d || '{}')); } catch { resolve({}); } });
    req.on('error', reject);
  });
}
function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}
function auth(b) {
  const room = rooms.get(String(b.code || ''));
  if (!room) return { err: [404, '房间不存在或已过期'] };
  const p = room.players.find(x => x.id === b.id && x.token === b.token);
  if (!p) return { err: [403, '你不在这个房间里'] };
  return { room, p };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
      return res.end(HTML);
    }
    if (req.method === 'GET' && url.pathname === '/api/events') {
      const a = auth(Object.fromEntries(url.searchParams));
      if (a.err) { res.writeHead(a.err[0]); return res.end(); }
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });
      res.write('retry: 2000\n\n');
      a.p.clients.add(res);
      broadcast(a.room);
      const ping = setInterval(() => res.write(': ping\n\n'), 15000);
      req.on('close', () => { clearInterval(ping); a.p.clients.delete(res); if (rooms.has(a.room.code)) broadcast(a.room); });
      return;
    }
    if (req.method !== 'POST') { res.writeHead(404); return res.end(); }
    const b = await readBody(req);

    if (url.pathname === '/api/create') {
      const p = newPlayer(b.name);
      const room = { code: newCode(), hostId: p.id, players: [p], phase: 'lobby', mode: 'standard',
        cards: {}, pile: [], turn: 0, pending: null, log: [], result: null, seq: 0, touched: Date.now() };
      rooms.set(room.code, room);
      return json(res, 200, { code: room.code, id: p.id, token: p.token });
    }
    if (url.pathname === '/api/join') {
      const room = rooms.get(String(b.code || '').trim());
      if (!room) return json(res, 404, { error: '房间不存在或已过期' });
      const back = room.players.find(x => x.id === b.id && x.token === b.token);
      if (back) return json(res, 200, { code: room.code, id: back.id, token: back.token });
      if (room.phase !== 'lobby') {
        // 游戏已开始：用原来的名字找回座位（浏览器丢失了登录信息时使用），优先匹配掉线的人
        const nm = cleanName(b.name);
        const seat = room.players.find(x => x.name === nm && !x.clients.size) || room.players.find(x => x.name === nm);
        if (seat) return json(res, 200, { code: room.code, id: seat.id, token: seat.token });
        const off = room.players.filter(x => !x.clients.size).map(x => `「${x.name}」`);
        return json(res, 409, { error: off.length
          ? `游戏已经开始了。如果你是掉线的玩家，请填写你原来的名字再点加入：${off.join('、')}`
          : '这个房间的游戏已经开始了' });
      }
      if (room.players.length >= 6) return json(res, 409, { error: '房间已满（最多 6 人）' });
      const p = newPlayer(b.name);
      room.players.push(p);
      broadcast(room);
      return json(res, 200, { code: room.code, id: p.id, token: p.token });
    }
    if (url.pathname === '/api/action') {
      const a = auth(b);
      if (a.err) return json(res, a.err[0], { error: a.err[1] });
      try { act(a.room, a.p, b); }
      catch (e) { if (e instanceof GameError) return json(res, 400, { error: e.message }); throw e; }
      if (rooms.has(a.room.code)) broadcast(a.room);
      return json(res, 200, { ok: true });
    }
    res.writeHead(404); res.end();
  } catch (e) {
    console.error(e);
    if (!res.headersSent) json(res, 500, { error: '服务器出错了' });
  }
});

setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms)
    if (!room.players.some(p => p.clients.size) && now - room.touched > ROOM_TTL) rooms.delete(code);
}, 10 * 60 * 1000);

if (require.main === module) server.listen(PORT, () => console.log(`调和之夜已启动： http://localhost:${PORT}`));
module.exports = { server, rooms, ROLES, endGame };
