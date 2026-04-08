const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');

const server = http.createServer((req, res) => {
  const filePath = req.url === '/' ? '/index.html' : req.url;
  const fullPath = path.join(__dirname, 'public', filePath);

  try {
    const content = fs.readFileSync(fullPath);
    const ext = path.extname(fullPath);
    const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
    res.writeHead(200, { 'Content-Type': types[ext] || 'text/plain' });
    res.end(content);
  } catch {
    res.writeHead(404);
    res.end();
  }
});

const wss = new WebSocket.Server({ server });

const rooms = {};
const playerSockets = new Map();

const MAX_PLAYERS = 10;
const MERCY_THRESHOLD = 25;
const TURN_TIME_MS = 20000;

const COLORS = ['red', 'blue', 'green', 'yellow'];

const SPECIALS = ['skip', 'reverse', '+2'];

function createDeck() {
  const deck = [];
  for (const c of COLORS) {
    deck.push({ color: c, type: 'number', value: '0' });
    for (let i = 0; i < 2; i++) {
      for (let n = 1; n <= 9; n++) {
        deck.push({ color: c, type: 'number', value: String(n) });
      }
      for (const s of SPECIALS) {
        deck.push({ color: c, type: s });
      }
    }
  }
  for (let i = 0; i < 4; i++) {
    deck.push({ color: 'wild', type: 'wild' });
    deck.push({ color: 'wild', type: '+4' });
  }
  return shuffle(deck);
}

function createNoMercyDeck() {
  const deck = [];
  for (const c of COLORS) {
    for (let k = 0; k < 2; k++) {
      for (let n = 0; n <= 9; n++) {
        deck.push({ color: c, type: 'number', value: String(n) });
      }
    }
  }
  for (const c of COLORS) {
    for (let i = 0; i < 3; i++) deck.push({ color: c, type: 'discardAll' });
    for (let i = 0; i < 3; i++) deck.push({ color: c, type: '+2' });
    for (let i = 0; i < 2; i++) deck.push({ color: c, type: '+4' });
    for (let i = 0; i < 3; i++) deck.push({ color: c, type: 'reverse' });
    for (let i = 0; i < 3; i++) deck.push({ color: c, type: 'skip' });
    for (let i = 0; i < 2; i++) deck.push({ color: c, type: 'skipEveryone' });
  }
  for (let i = 0; i < 8; i++) deck.push({ color: 'wild', type: 'colorRoulette' });
  for (let i = 0; i < 8; i++) deck.push({ color: 'wild', type: 'wildReverseDraw4' });
  for (let i = 0; i < 4; i++) deck.push({ color: 'wild', type: '+6' });
  for (let i = 0; i < 4; i++) deck.push({ color: 'wild', type: '+10' });
  return shuffle(deck);
}

function createDeckForMode(gameMode) {
  return gameMode === 'noMercy' ? createNoMercyDeck() : createDeck();
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function effectiveTopColor(topCard) {
  if (topCard.color === 'wild' && topCard.chosenColor) {
    return topCard.chosenColor;
  }
  return topCard.color;
}

function takeStarterDiscard(deck) {
  const idx = deck.findIndex(c => c.type === 'number');
  if (idx === -1) return deck.pop();
  const [starter] = deck.splice(idx, 1);
  return starter;
}

function activePlayers(room) {
  return room.players.filter((p) => !p.spectator);
}

function currentTurnPlayer(room) {
  const act = activePlayers(room);
  if (act.length === 0) return null;
  const i = ((room.turn % act.length) + act.length) % act.length;
  return act[i];
}

function turnIndexOfPlayerId(room, playerId) {
  const act = activePlayers(room);
  return act.findIndex(p => p.id === playerId);
}

function drawPenaltyValue(card) {
  if (!card) return 0;
  if (card.type === '+2') return 2;
  if (card.type === '+4') return 4;
  if (card.type === '+6') return 6;
  if (card.type === '+10') return 10;
  if (card.type === 'wildReverseDraw4') return 4;
  return 0;
}

function isWildCard(card) {
  return card && card.color === 'wild';
}

function requiresChosenColor(card) {
  return isWildCard(card);
}

function generateCode() {
  return Math.random().toString(36).substring(2, 7).toUpperCase();
}

function playerForClient(p) {
  if (!p) return p;
  const { ws, ...rest } = p;
  return rest;
}

function roomForClient(room) {
  if (!room) return room;
  const { turnTimer, roundTimer, turnTimerForPlayerId, ...rest } = room;
  return {
    ...rest,
    players: room.players.map(playerForClient),
  };
}

function broadcast(roomCode, message, excludeWs = null) {
  let outgoing = message;
  if (message.room || message.player) {
    outgoing = { ...message };
    if (message.room) outgoing.room = roomForClient(message.room);
    if (message.player) outgoing.player = playerForClient(message.player);
  }
  wss.clients.forEach((ws) => {
    const info = playerSockets.get(ws);
    if (info && info.roomCode === roomCode && ws !== excludeWs && ws.readyState === 1) {
      ws.send(JSON.stringify(outgoing));
    }
  });
}

function ensureDeckDraw(room, n) {
  if (room.deck.length >= n) return true;
  const bottom = room.discard.slice(0, -1);
  if (bottom.length === 0 && room.deck.length === 0) return false;
  room.deck.push(...shuffle(bottom));
  room.discard = [room.discard[room.discard.length - 1]];
  return room.deck.length >= n;
}

function stripWildColors(arr) {
  for (const c of arr) {
    if (c && c.color === 'wild') delete c.chosenColor;
  }
}

function clearRoundTimer(room) {
  if (room && room.roundTimer) {
    clearTimeout(room.roundTimer);
    room.roundTimer = null;
  }
}

function clearTurnTimer(room) {
  if (room && room.turnTimer) {
    clearTimeout(room.turnTimer);
    room.turnTimer = null;
  }
  if (room) {
    room.turnTimerForPlayerId = null;
    room.turnEndsAt = null;
  }
}

/** After a No Mercy session ends, keep the room open so the host can start a new game (rematch). */
function resetNoMercyToLobby(room, roomCode, winnerName, reason) {
  clearRoundTimer(room);
  clearTurnTimer(room);
  room.started = false;
  room.deck = [];
  room.discard = [];
  room.drawStack = 0;
  room.drawStackFace = 0;
  room.pendingAction = null;
  room.direction = 1;
  room.turn = 0;
  room.turnTimerForPlayerId = null;
  room.turnEndsAt = null;
  room.roundTimer = null;
  for (const p of room.players) {
    p.spectator = false;
    p.hand = [];
  }
  broadcast(roomCode, {
    type: 'gameOver',
    winner: winnerName,
    final: false,
    backToLobby: true,
    reason: reason || 'lastPlayer',
    room,
  });
}

function noMercyGameOverIfOneActive(room, roomCode) {
  const act = activePlayers(room);
  if (act.length !== 1) return false;
  const sole = act[0];
  resetNoMercyToLobby(room, roomCode, sole.name, 'lastPlayer');
  return true;
}

function eliminateForMercy(room, roomCode, playerIdx) {
  const p = room.players[playerIdx];
  if (!p || p.spectator) return;
  const currentId = currentTurnPlayer(room) ? currentTurnPlayer(room).id : null;
  stripWildColors(p.hand);
  room.deck.push(...p.hand);
  shuffle(room.deck);
  p.hand = [];
  p.spectator = true;
  broadcast(roomCode, { type: 'playerEliminated', playerName: p.name, playerId: p.id, room });
  const act = activePlayers(room);
  if (currentId) {
    const idx = act.findIndex((x) => x.id === currentId);
    if (idx >= 0) room.turn = idx;
    else room.turn = 0;
  }
  room.turn = act.length ? ((room.turn % act.length) + act.length) % act.length : 0;
  if (noMercyGameOverIfOneActive(room, roomCode)) return true;
  return false;
}

function applyMercyRule(room, roomCode) {
  if (room.gameMode !== 'noMercy' || !room.started) return false;
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 0; i < room.players.length; i++) {
      const p = room.players[i];
      if (!p.spectator && p.hand.length >= MERCY_THRESHOLD) {
        if (eliminateForMercy(room, roomCode, i)) return true;
        changed = true;
        break;
      }
    }
  }
  return false;
}

function rotateHandsNoMercy(room) {
  const act = activePlayers(room);
  if (act.length < 2) return;
  const hands = act.map((p) => p.hand.slice());
  const len = act.length;
  for (let i = 0; i < len; i++) {
    const from = (i - room.direction + len + len) % len;
    act[i].hand = hands[from];
  }
}

function applyRouletteForPlayer(room, roomCode, player, rouletteColor) {
  let n = 0;
  while (n < 200) {
    n++;
    if (!ensureDeckDraw(room, 1)) break;
    const [drawn] = room.deck.splice(0, 1);
    player.hand.push(drawn);
    if (drawn.color === rouletteColor) break;
  }
}

function advanceTurnBy(room, steps) {
  const act = activePlayers(room);
  if (act.length === 0) return;
  const curIdx = room.turn % act.length;
  room.turn = (curIdx + steps * room.direction + act.length * 10) % act.length;
}

function playValidClassic(card, topCard, drawStack) {
  if (drawStack > 0) {
    return (card.type === '+2' && topCard.type === '+2') || (card.type === '+4' && topCard.type === '+4');
  }
  if (card.color === 'wild') return true;
  const topColor = effectiveTopColor(topCard);
  return (
    card.color === topColor ||
    (card.type === topCard.type && card.type !== 'number') ||
    (card.type === 'number' && card.value === topCard.value)
  );
}

function playValidNoMercy(card, topCard, room) {
  const drawStack = room.drawStack;
  const face = room.drawStackFace || 0;
  if (drawStack > 0) {
    const v = drawPenaltyValue(card);
    return v > 0 && v >= face;
  }
  if (isWildCard(card)) return true;
  const topColor = effectiveTopColor(topCard);
  return (
    card.color === topColor ||
    (card.type === topCard.type && card.type !== 'number') ||
    (card.type === 'number' && topCard.type === 'number' && card.value === topCard.value)
  );
}

function afterPlayEffectsClassic(room, card, player, roomCode) {
  let skipNext = false;
  if (card.type === 'skip') {
    skipNext = true;
  } else if (card.type === 'reverse') {
    room.direction *= -1;
    if (activePlayers(room).length === 2) skipNext = true;
  } else if (card.type === '+2') {
    room.drawStack += 2;
  } else if (card.type === '+4') {
    room.drawStack += 4;
  }
  if (player.hand.length === 0) {
    handleRoundWin(room, roomCode, player);
    return { done: true };
  }
  if (!skipNext) {
    advanceTurnBy(room, 1);
  } else {
    advanceTurnBy(room, 2);
  }
  return { done: false };
}

function afterPlayEffectsNoMercy(room, card, player, roomCode) {
  let skipSteps = 1;

  if (card.type === 'colorRoulette') {
    const rouletteColor = card.chosenColor;
    advanceTurnBy(room, 1);
    const victim = currentTurnPlayer(room);
    if (victim) {
      applyRouletteForPlayer(room, roomCode, victim, rouletteColor);
      if (applyMercyRule(room, roomCode)) return { done: true };
      advanceTurnBy(room, 1);
    }
    if (player.hand.length === 0) {
      handleRoundWin(room, roomCode, player);
      return { done: true };
    }
    startTurnTimer(room, roomCode);
    broadcast(roomCode, { type: 'stateUpdate', room });
    return { done: true };
  }

  if (card.type === 'skip') {
    skipSteps = 2;
  } else if (card.type === 'skipEveryone') {
    skipSteps = 0;
  } else if (card.type === 'reverse') {
    room.direction *= -1;
    if (activePlayers(room).length === 2) skipSteps = 2;
  } else if (card.type === 'wildReverseDraw4') {
    room.direction *= -1;
    const v = 4;
    room.drawStack += v;
    room.drawStackFace = v;
  } else if (card.type === '+2' || card.type === '+4' || card.type === '+6' || card.type === '+10') {
    const v = drawPenaltyValue(card);
    room.drawStack += v;
    room.drawStackFace = v;
  } else if (card.type === 'discardAll') {
    const col = card.color;
    const toDiscard = player.hand.filter((c) => c.color === col);
    stripWildColors(toDiscard);
    player.hand = player.hand.filter((c) => c.color !== col);
    room.discard.push(...toDiscard);
  } else if (card.type === 'number' && card.value === '0') {
    rotateHandsNoMercy(room);
  } else if (card.type === 'number' && card.value === '7') {
    const targets = activePlayers(room).filter((p) => p.id !== player.id);
    if (targets.length === 0) {
      // Fallback: if no eligible target exists, do not lock turn flow.
      if (applyMercyRule(room, roomCode)) return { done: true };
      if (player.hand.length === 0) {
        handleRoundWin(room, roomCode, player);
        return { done: true };
      }
      advanceTurnBy(room, 1);
      startTurnTimer(room, roomCode);
      broadcast(roomCode, { type: 'stateUpdate', room });
      return { done: true };
    }
    room.pendingAction = { kind: 'swap7', forPlayerId: player.id };
    startTurnTimer(room, roomCode);
    broadcast(roomCode, { type: 'stateUpdate', room });
    return { done: true, pending: true };
  }

  if (applyMercyRule(room, roomCode)) return { done: true };
  if (player.hand.length === 0) {
    handleRoundWin(room, roomCode, player);
    return { done: true };
  }

  if (skipSteps > 0) advanceTurnBy(room, skipSteps);
  startTurnTimer(room, roomCode);
  broadcast(roomCode, { type: 'stateUpdate', room });
  return { done: true };
}

function handleRoundWin(room, roomCode, player) {
  clearRoundTimer(room);
  clearTurnTimer(room);
  const winnerName = player.name;
  const winnerId = player.id;
  const act = activePlayers(room);
  if (act.length <= 1) {
    if (room.gameMode === 'noMercy') {
      resetNoMercyToLobby(room, roomCode, winnerName, 'sessionEnd');
    } else {
      broadcast(roomCode, { type: 'gameOver', winner: winnerName, final: true });
      delete rooms[roomCode];
    }
    return;
  }
  broadcast(roomCode, { type: 'roundOver', winner: winnerName });
  room.roundTimer = setTimeout(() => {
    room.roundTimer = null;
    const r = rooms[roomCode];
    if (!r || !r.started) return;
    if (activePlayers(r).length < 2) return;
    startNewRound(r);
    const wi = turnIndexOfPlayerId(r, winnerId);
    if (wi >= 0) r.turn = wi;
    startTurnTimer(r, roomCode);
    broadcast(roomCode, { type: 'newRound', room: r });
  }, 4500);
}

function startNewRound(room) {
  room.deck = createDeckForMode(room.gameMode || 'classic');
  room.discard = [takeStarterDiscard(room.deck)];
  room.drawStack = 0;
  room.drawStackFace = 0;
  room.direction = 1;
  room.turn = 0;
  room.pendingAction = null;
  const act = activePlayers(room);
  for (const p of act) {
    p.hand = room.deck.splice(0, 7);
  }
}

function executeDrawForCurrentPlayer(room, roomCode) {
  const player = currentTurnPlayer(room);
  if (!player) return false;
  const drawCount = room.drawStack > 0 ? room.drawStack : 1;
  if (!ensureDeckDraw(room, drawCount)) return false;
  const drawn = room.deck.splice(0, drawCount);
  player.hand.push(...drawn);
  room.drawStack = 0;
  room.drawStackFace = 0;
  if (room.gameMode === 'noMercy' && applyMercyRule(room, roomCode)) return true;
  advanceTurnBy(room, 1);
  return true;
}

function drawUntilPlayableNoMercy(room, roomCode) {
  const player = currentTurnPlayer(room);
  if (!player || room.drawStack > 0) return false;
  const topCard = room.discard[room.discard.length - 1];
  let guard = 0;
  while (guard < 500) {
    guard++;
    if (!ensureDeckDraw(room, 1)) return false;
    const [drawn] = room.deck.splice(0, 1);
    player.hand.push(drawn);
    if (applyMercyRule(room, roomCode)) return true;
    const fakeRoom = { ...room, drawStack: 0, drawStackFace: 0 };
    if (playValidNoMercy(drawn, topCard, fakeRoom)) break;
  }
  return true;
}

function resolveSwap7(room, roomCode, actorId, requestedTargetId = null) {
  const actor = room.players.find((p) => p.id === actorId && !p.spectator);
  if (!actor) return false;
  const targets = activePlayers(room).filter((p) => p.id !== actor.id);
  if (targets.length === 0) return false;
  const target =
    (requestedTargetId && targets.find((p) => p.id === requestedTargetId)) ||
    targets[0];
  if (!target) return false;
  const tmp = actor.hand;
  actor.hand = target.hand;
  target.hand = tmp;
  room.pendingAction = null;
  if (applyMercyRule(room, roomCode)) return true;
  advanceTurnBy(room, 1);
  clearTurnTimer(room);
  startTurnTimer(room, roomCode);
  broadcast(roomCode, { type: 'stateUpdate', room });
  return true;
}

function startTurnTimer(room, roomCode) {
  clearTurnTimer(room);
  const act = activePlayers(room);
  if (!room.started || act.length < 2) return;
  if (room.pendingAction) {
    if (room.pendingAction.kind === 'swap7' && room.pendingAction.forPlayerId) {
      const pendingActorId = room.pendingAction.forPlayerId;
      room.turnTimerForPlayerId = pendingActorId;
      room.turnEndsAt = Date.now() + TURN_TIME_MS;
      room.turnTimer = setTimeout(() => {
        room.turnTimer = null;
        room.turnTimerForPlayerId = null;
        const r = rooms[roomCode];
        if (!r || !r.started || !r.pendingAction) return;
        if (r.pendingAction.kind !== 'swap7' || r.pendingAction.forPlayerId !== pendingActorId) return;
        // Fallback so a missed/hidden target picker cannot deadlock the game.
        if (!resolveSwap7(r, roomCode, pendingActorId, null)) {
          r.pendingAction = null;
          advanceTurnBy(r, 1);
          startTurnTimer(r, roomCode);
          broadcast(roomCode, { type: 'stateUpdate', room: r });
        }
      }, TURN_TIME_MS);
    }
    return;
  }
  const current = currentTurnPlayer(room);
  if (!current || current.spectator) return;
  const expectedId = current.id;
  room.turnTimerForPlayerId = expectedId;
  room.turnEndsAt = Date.now() + TURN_TIME_MS;
  room.turnTimer = setTimeout(() => {
    room.turnTimer = null;
    room.turnTimerForPlayerId = null;
    const r = rooms[roomCode];
    if (!r || !r.started || activePlayers(r).length < 2) return;
    const cur = currentTurnPlayer(r);
    if (!cur || cur.id !== expectedId) return;
    if (r.gameMode === 'noMercy' && r.drawStack === 0) {
      drawUntilPlayableNoMercy(r, roomCode);
      startTurnTimer(r, roomCode);
      broadcast(roomCode, { type: 'stateUpdate', room: r });
      return;
    }
    if (!executeDrawForCurrentPlayer(r, roomCode)) {
      startTurnTimer(r, roomCode);
      broadcast(roomCode, { type: 'stateUpdate', room: r });
      return;
    }
    startTurnTimer(r, roomCode);
    broadcast(roomCode, { type: 'stateUpdate', room: r });
  }, TURN_TIME_MS);
}

wss.on('connection', (ws) => {
  console.log('Client connected');

  ws.on('message', (data) => {
    const msg = JSON.parse(data);
    const { type, roomCode, playerId, playerName } = msg;

    if (type === 'reconnect') {
      const room = rooms[roomCode];
      if (room) {
        const player = room.players.find((p) => p.id === playerId);
        if (player) {
          player.ws = ws;
          player.connected = true;
          playerSockets.set(ws, { roomCode, playerId });
          ws.send(JSON.stringify({ type: 'reconnected', room: roomForClient(room), you: playerForClient(player) }));
          broadcast(roomCode, { type: 'playerReconnected', playerName: player.name, room });
          return;
        }
      }
      ws.send(JSON.stringify({ type: 'reconnectFailed' }));
      return;
    }

    if (type === 'create') {
      const gm = msg.gameMode === 'noMercy' ? 'noMercy' : 'classic';
      const code = generateCode();
      const newPlayerId = Math.random().toString(36).substring(2, 10);
      rooms[code] = {
        code,
        gameMode: gm,
        hostId: newPlayerId,
        players: [
          {
            id: newPlayerId,
            name: playerName,
            hand: [],
            ws,
            connected: true,
            spectator: false,
          },
        ],
        deck: [],
        discard: [],
        started: false,
        turn: 0,
        direction: 1,
        drawStack: 0,
        drawStackFace: 0,
        pendingAction: null,
        roundTimer: null,
        turnTimer: null,
        turnTimerForPlayerId: null,
        turnEndsAt: null,
      };
      playerSockets.set(ws, { roomCode: code, playerId: newPlayerId });
      ws.send(JSON.stringify({ type: 'created', roomCode: code, playerId: newPlayerId, room: roomForClient(rooms[code]) }));
    }

    if (type === 'join') {
      const room = rooms[roomCode];
      if (!room) {
        ws.send(JSON.stringify({ type: 'error', message: 'Room not found' }));
        return;
      }
      if (room.started) {
        ws.send(JSON.stringify({ type: 'error', message: 'Game already started' }));
        return;
      }
      if (room.players.length >= MAX_PLAYERS) {
        ws.send(JSON.stringify({ type: 'error', message: `Room full (max ${MAX_PLAYERS})` }));
        return;
      }
      const newPlayerId = Math.random().toString(36).substring(2, 10);
      const player = {
        id: newPlayerId,
        name: playerName,
        hand: [],
        ws,
        connected: true,
        spectator: false,
      };
      room.players.push(player);
      playerSockets.set(ws, { roomCode, playerId: newPlayerId });
      ws.send(JSON.stringify({ type: 'joined', playerId: newPlayerId, room: roomForClient(room) }));
      broadcast(roomCode, { type: 'playerJoined', player, room }, ws);
    }

    if (type === 'chooseSwapTarget') {
      const room = rooms[roomCode];
      if (!room || !room.started || room.gameMode !== 'noMercy') return;
      const pending = room.pendingAction;
      if (!pending || pending.kind !== 'swap7' || pending.forPlayerId !== playerId) return;
      const targetId = msg.targetPlayerId;
      const actor = room.players.find((p) => p.id === playerId && !p.spectator);
      const target = room.players.find((p) => p.id === targetId && !p.spectator && p.id !== playerId);
      if (!actor || !target) {
        ws.send(JSON.stringify({ type: 'invalidMove' }));
        return;
      }
      resolveSwap7(room, roomCode, playerId, targetId);
      return;
    }

    if (type === 'start') {
      const room = rooms[roomCode];
      if (!room || room.hostId !== playerId || room.players.length < 2) return;

      clearRoundTimer(room);
      clearTurnTimer(room);
      room.started = true;
      room.deck = createDeckForMode(room.gameMode);
      room.discard = [takeStarterDiscard(room.deck)];
      room.drawStack = 0;
      room.drawStackFace = 0;
      room.pendingAction = null;
      room.direction = 1;
      room.turn = 0;
      const act = activePlayers(room);
      for (const p of act) {
        p.hand = room.deck.splice(0, 7);
      }
      startTurnTimer(room, roomCode);
      broadcast(roomCode, { type: 'gameStarted', room });
    }

    if (type === 'play') {
      const room = rooms[roomCode];
      if (!room || !room.started) return;

      const player = room.players.find((p) => p.id === playerId);
      if (!player || player.spectator) return;
      const currentPlayer = currentTurnPlayer(room);
      if (player !== currentPlayer) return;
      if (room.pendingAction) return;

      const cardIndex = msg.cardIndex;
      const chosenColor = msg.chosenColor;
      const card = player.hand[cardIndex];
      if (!card) return;
      const topCard = room.discard[room.discard.length - 1];

      if (requiresChosenColor(card) && !chosenColor) {
        ws.send(JSON.stringify({ type: 'invalidMove' }));
        return;
      }

      let valid = false;
      if (room.gameMode === 'noMercy') {
        valid = playValidNoMercy(card, topCard, room);
      } else {
        valid = playValidClassic(card, topCard, room.drawStack);
      }
      if (!valid) {
        ws.send(JSON.stringify({ type: 'invalidMove' }));
        return;
      }

      clearTurnTimer(room);
      player.hand.splice(cardIndex, 1);
      if (requiresChosenColor(card)) card.chosenColor = chosenColor;
      room.discard.push(card);

      if (room.gameMode === 'classic') {
        const out = afterPlayEffectsClassic(room, card, player, roomCode);
        if (out.done) return;
        startTurnTimer(room, roomCode);
        broadcast(roomCode, { type: 'stateUpdate', room });
        return;
      }

      const out = afterPlayEffectsNoMercy(room, card, player, roomCode);
      if (out.done) return;
      startTurnTimer(room, roomCode);
      broadcast(roomCode, { type: 'stateUpdate', room });
      return;
    }

    if (type === 'draw') {
      const room = rooms[roomCode];
      if (!room || !room.started) return;

      const player = room.players.find((p) => p.id === playerId);
      if (!player || player.spectator) return;
      if (currentTurnPlayer(room) !== player) return;
      if (room.pendingAction) return;

      clearTurnTimer(room);
      if (room.gameMode === 'noMercy' && room.drawStack === 0) {
        drawUntilPlayableNoMercy(room, roomCode);
        if (!rooms[roomCode]) return;
        if (applyMercyRule(room, roomCode)) return;
      } else {
        if (!executeDrawForCurrentPlayer(room, roomCode)) {
          startTurnTimer(room, roomCode);
          broadcast(roomCode, { type: 'stateUpdate', room });
          return;
        }
        if (!rooms[roomCode]) return;
        if (room.gameMode === 'noMercy' && applyMercyRule(room, roomCode)) return;
      }
      startTurnTimer(room, roomCode);
      broadcast(roomCode, { type: 'stateUpdate', room });
      return;
    }

    if (type === 'kick') {
      const room = rooms[roomCode];
      if (!room || room.hostId !== playerId) return;
      const targetId = msg.targetPlayerId;
      if (!targetId || targetId === playerId) return;
      const kickIdx = room.players.findIndex((p) => p.id === targetId);
      if (kickIdx === -1) return;
      const kicked = room.players[kickIdx];
      const targetWs = kicked.ws;

      clearRoundTimer(room);
      clearTurnTimer(room);

      const actBeforeKick = activePlayers(room);
      const oldTurnIdx =
        actBeforeKick.length > 0
          ? ((room.turn % actBeforeKick.length) + actBeforeKick.length) % actBeforeKick.length
          : 0;
      const curIdBefore = actBeforeKick[oldTurnIdx] ? actBeforeKick[oldTurnIdx].id : null;
      const activeKickIdx = actBeforeKick.findIndex((p) => p.id === kicked.id);

      stripWildColors(kicked.hand);
      room.deck.push(...kicked.hand);
      shuffle(room.deck);

      room.players.splice(kickIdx, 1);
      if (targetWs) playerSockets.delete(targetWs);
      try {
        if (targetWs) targetWs.send(JSON.stringify({ type: 'kicked' }));
      } catch (_) {}

      if (kicked.id === room.hostId && room.players.length > 0) {
        room.hostId = room.players[0].id;
      }

      if (room.players.length === 0) {
        delete rooms[roomCode];
        return;
      }

      const act = activePlayers(room);
      if (room.started && act.length === 1) {
        const sole = act[0];
        broadcast(roomCode, {
          type: 'gameOver',
          winner: sole.name,
          final: true,
          reason: 'lastPlayer',
        });
        delete rooms[roomCode];
        return;
      }

      if (room.players.length === 1 && !room.started) {
        const sole = room.players[0];
        broadcast(roomCode, {
          type: 'gameOver',
          winner: sole.name,
          final: true,
          reason: 'lastPlayer',
        });
        delete rooms[roomCode];
        return;
      }

      if (!room.started) {
        broadcast(roomCode, { type: 'playerLeft', playerName: kicked.name, room, reason: 'kick' });
        return;
      }

      if (act.length >= 2 && curIdBefore) {
        if (curIdBefore === kicked.id) {
          room.turn = activeKickIdx >= 0 ? activeKickIdx % act.length : 0;
        } else {
          const idx = act.findIndex((p) => p.id === curIdBefore);
          room.turn = idx >= 0 ? idx : 0;
        }
        room.turn = ((room.turn % act.length) + act.length) % act.length;
      }

      broadcast(roomCode, { type: 'playerLeft', playerName: kicked.name, room, reason: 'kick' });
      startTurnTimer(room, roomCode);
      broadcast(roomCode, { type: 'stateUpdate', room });
      return;
    }

    if (type === 'leave') {
      const room = rooms[roomCode];
      if (!room) return;
      const leaveIdx = room.players.findIndex((p) => p.id === playerId);
      if (leaveIdx === -1) return;
      const quitter = room.players[leaveIdx];
      clearRoundTimer(room);
      clearTurnTimer(room);

      const actBeforeLeave = activePlayers(room);
      const oldTurnIdxLeave =
        actBeforeLeave.length > 0
          ? ((room.turn % actBeforeLeave.length) + actBeforeLeave.length) % actBeforeLeave.length
          : 0;
      const curIdBefore = actBeforeLeave[oldTurnIdxLeave] ? actBeforeLeave[oldTurnIdxLeave].id : null;
      const activeLeaveIdx = actBeforeLeave.findIndex((p) => p.id === quitter.id);

      stripWildColors(quitter.hand);
      room.deck.push(...quitter.hand);
      shuffle(room.deck);

      room.players.splice(leaveIdx, 1);
      playerSockets.delete(ws);

      try {
        ws.send(JSON.stringify({ type: 'leftRoom' }));
      } catch (_) {}

      if (quitter.id === room.hostId && room.players.length > 0) {
        room.hostId = room.players[0].id;
      }

      if (room.players.length === 0) {
        delete rooms[roomCode];
        return;
      }

      const act = activePlayers(room);
      if (room.started && act.length === 1) {
        const sole = act[0];
        broadcast(roomCode, {
          type: 'gameOver',
          winner: sole.name,
          final: true,
          reason: 'lastPlayer',
        });
        delete rooms[roomCode];
        return;
      }

      if (room.players.length === 1 && !room.started) {
        const sole = room.players[0];
        broadcast(roomCode, {
          type: 'gameOver',
          winner: sole.name,
          final: true,
          reason: 'lastPlayer',
        });
        delete rooms[roomCode];
        return;
      }

      if (!room.started) {
        broadcast(roomCode, { type: 'playerLeft', playerName: quitter.name, room });
        return;
      }

      if (act.length >= 2 && curIdBefore) {
        if (curIdBefore === quitter.id) {
          room.turn = activeLeaveIdx >= 0 ? activeLeaveIdx % act.length : 0;
        } else {
          const idx = act.findIndex((p) => p.id === curIdBefore);
          room.turn = idx >= 0 ? idx : 0;
        }
        room.turn = ((room.turn % act.length) + act.length) % act.length;
      }

      broadcast(roomCode, { type: 'playerLeft', playerName: quitter.name, room });
      startTurnTimer(room, roomCode);
      broadcast(roomCode, { type: 'stateUpdate', room });
      return;
    }
  });

  ws.on('close', () => {
    const info = playerSockets.get(ws);
    if (info) {
      const { roomCode: rc, playerId: pid } = info;
      const room = rooms[rc];
      if (room) {
        const player = room.players.find((p) => p.id === pid);
        if (player) {
          player.connected = false;
          broadcast(rc, { type: 'playerDisconnected', playerName: player.name, room });
          setTimeout(() => {
            if (rooms[rc] && rooms[rc].players.every((p) => !p.connected)) {
              delete rooms[rc];
            }
          }, 300000);
        }
      }
      playerSockets.delete(ws);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server on ${PORT}`));
