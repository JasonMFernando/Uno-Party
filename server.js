const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');

// Serve static files
const server = http.createServer((req, res) => {
  const filePath = req.url === '/' ? '/index.html' : req.url;
  const fullPath = path.join(__dirname, 'public', filePath);
  
  try {
    const content = fs.readFileSync(fullPath);
    const ext = path.extname(fullPath);
    const types = {'.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml'};
    res.writeHead(200, {'Content-Type': types[ext] || 'text/plain'});
    res.end(content);
  } catch {
    res.writeHead(404);
    res.end();
  }
});

const wss = new WebSocket.Server({ server });

// In-memory state
const rooms = {}; // code -> room data
const playerSockets = new Map(); // ws -> {roomCode, playerId}

const MAX_PLAYERS = 10;

// Card definitions
const COLORS = ['red', 'blue', 'green', 'yellow'];
const NUMBERS = ['0','1','2','3','4','5','6','7','8','9'];
const SPECIALS = ['skip', 'reverse', '+2'];
const WILDS = ['wild', '+4'];

function createDeck() {
  const deck = [];
  // Number cards (1 of 0, 2 of 1-9 each color)
  for (const c of COLORS) {
    deck.push({color: c, type: 'number', value: '0'});
    for (let i = 0; i < 2; i++) {
      for (let n = 1; n <= 9; n++) {
        deck.push({color: c, type: 'number', value: String(n)});
      }
      for (const s of SPECIALS) {
        deck.push({color: c, type: s});
      }
    }
  }
  // Wilds (4 each)
  for (let i = 0; i < 4; i++) {
    deck.push({color: 'wild', type: 'wild'});
    deck.push({color: 'wild', type: '+4'});
  }
  return shuffle(deck);
}

function effectiveTopColor(topCard) {
  if (topCard.color === 'wild' && topCard.chosenColor) {
    return topCard.chosenColor;
  }
  return topCard.color;
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/** First discard of a round must be a number card so color is defined (not wild / skip / +2 / +4 / reverse). */
function takeStarterDiscard(deck) {
  const idx = deck.findIndex(c => c.type === 'number');
  if (idx === -1) return deck.pop();
  const [starter] = deck.splice(idx, 1);
  return starter;
}

function generateCode() {
  return Math.random().toString(36).substring(2, 7).toUpperCase();
}

function playerForClient(p) {
  if (!p) return p;
  const { ws, ...rest } = p;
  return rest;
}

/** Strip WebSockets and Node timers — JSON.stringify cannot serialize them. */
function roomForClient(room) {
  if (!room) return room;
  const {
    turnTimer,
    roundTimer,
    turnTimerForPlayerId,
    ...rest
  } = room;
  return {
    ...rest,
    players: room.players.map(playerForClient)
  };
}

function broadcast(roomCode, message, excludeWs = null) {
  let outgoing = message;
  if (message.room || message.player) {
    outgoing = { ...message };
    if (message.room) outgoing.room = roomForClient(message.room);
    if (message.player) outgoing.player = playerForClient(message.player);
  }
  wss.clients.forEach(ws => {
    const info = playerSockets.get(ws);
    if (info && info.roomCode === roomCode && ws !== excludeWs && ws.readyState === 1) {
      ws.send(JSON.stringify(outgoing));
    }
  });
}

const TURN_TIME_MS = 20000;

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

function startTurnTimer(room, roomCode) {
  clearTurnTimer(room);
  if (!room.started || room.players.length < 2) return;
  const current = room.players[room.turn];
  if (!current) return;
  const expectedId = current.id;
  room.turnTimerForPlayerId = expectedId;
  room.turnEndsAt = Date.now() + TURN_TIME_MS;
  room.turnTimer = setTimeout(() => {
    room.turnTimer = null;
    room.turnTimerForPlayerId = null;
    const r = rooms[roomCode];
    if (!r || !r.started || r.players.length < 2) return;
    if (r.players[r.turn].id !== expectedId) return;
    if (!executeDrawForCurrentPlayer(r, roomCode)) {
      startTurnTimer(r, roomCode);
      broadcast(roomCode, { type: 'stateUpdate', room: r });
      return;
    }
    startTurnTimer(r, roomCode);
    broadcast(roomCode, { type: 'stateUpdate', room: r });
  }, TURN_TIME_MS);
}

/** Draw for whoever is current; advances turn. Returns false if deck empty (rare). */
function executeDrawForCurrentPlayer(room, roomCode) {
  const player = room.players[room.turn];
  if (!player) return false;
  const drawCount = room.drawStack > 0 ? room.drawStack : 1;
  if (room.deck.length < drawCount) {
    const bottom = room.discard.slice(0, -1);
    if (bottom.length === 0 && room.deck.length === 0) return false;
    room.deck.push(...shuffle(bottom));
    room.discard = [room.discard[room.discard.length - 1]];
  }
  if (room.deck.length < drawCount) return false;
  const drawn = room.deck.splice(0, drawCount);
  player.hand.push(...drawn);
  room.drawStack = 0;
  room.turn = (room.turn + room.direction + room.players.length) % room.players.length;
  return true;
}

function startNewRound(room) {
  room.deck = createDeck();
  room.discard = [takeStarterDiscard(room.deck)];
  room.drawStack = 0;
  room.direction = 1;
  room.turn = 0;
  for (const p of room.players) {
    p.hand = room.deck.splice(0, 7);
  }
}

wss.on('connection', (ws) => {
  console.log('Client connected');

  ws.on('message', (data) => {
    const msg = JSON.parse(data);
    const { type, roomCode, playerId, playerName } = msg;

    // RECONNECT: Check if returning player
    if (type === 'reconnect') {
      const room = rooms[roomCode];
      if (room) {
        const player = room.players.find(p => p.id === playerId);
        if (player) {
          player.ws = ws;
          player.connected = true;
          playerSockets.set(ws, {roomCode, playerId});
          ws.send(JSON.stringify({type: 'reconnected', room: roomForClient(room), you: playerForClient(player)}));
          broadcast(roomCode, {type: 'playerReconnected', playerName: player.name, room});
          return;
        }
      }
      ws.send(JSON.stringify({type: 'reconnectFailed'}));
      return;
    }

    // CREATE ROOM
    if (type === 'create') {
      const code = generateCode();
      const newPlayerId = Math.random().toString(36).substring(2, 10);
      rooms[code] = {
        code,
        hostId: newPlayerId,
        players: [{
          id: newPlayerId, 
          name: playerName, 
          hand: [], 
          ws, 
          connected: true
        }],
        deck: [],
        discard: [],
        started: false,
        turn: 0,
        direction: 1,
        drawStack: 0, // For stacking +2/+4
        roundTimer: null,
        turnTimer: null,
        turnTimerForPlayerId: null,
        turnEndsAt: null
      };
      playerSockets.set(ws, {roomCode: code, playerId: newPlayerId});
      ws.send(JSON.stringify({type: 'created', roomCode: code, playerId: newPlayerId, room: roomForClient(rooms[code])}));
    }

    // JOIN ROOM
    if (type === 'join') {
      const room = rooms[roomCode];
      if (!room) {
        ws.send(JSON.stringify({type: 'error', message: 'Room not found'}));
        return;
      }
      if (room.started) {
        ws.send(JSON.stringify({type: 'error', message: 'Game already started'}));
        return;
      }
      if (room.players.length >= MAX_PLAYERS) {
        ws.send(JSON.stringify({type: 'error', message: `Room full (max ${MAX_PLAYERS})`}));
        return;
      }
      const newPlayerId = Math.random().toString(36).substring(2, 10);
      const player = {
        id: newPlayerId,
        name: playerName,
        hand: [],
        ws,
        connected: true
      };
      room.players.push(player);
      playerSockets.set(ws, {roomCode, playerId: newPlayerId});
      ws.send(JSON.stringify({type: 'joined', playerId: newPlayerId, room: roomForClient(room)}));
      broadcast(roomCode, {type: 'playerJoined', player, room}, ws);
    }

    // START GAME
    if (type === 'start') {
      const room = rooms[roomCode];
      if (!room || room.hostId !== playerId || room.players.length < 2) return;
      
      clearRoundTimer(room);
      clearTurnTimer(room);
      room.started = true;
      room.deck = createDeck();
      room.discard = [takeStarterDiscard(room.deck)];
      
      // Deal 7 cards each
      for (const p of room.players) {
        p.hand = room.deck.splice(0, 7);
      }
      
      startTurnTimer(room, roomCode);
      broadcast(roomCode, {type: 'gameStarted', room});
    }

    // PLAY CARD
    if (type === 'play') {
      const room = rooms[roomCode];
      if (!room || !room.started) return;
      
      const player = room.players.find(p => p.id === playerId);
      const currentPlayer = room.players[room.turn];
      if (player !== currentPlayer) return; // Not their turn
      
      const cardIndex = msg.cardIndex;
      const chosenColor = msg.chosenColor; // For wilds
      const card = player.hand[cardIndex];
      const topCard = room.discard[room.discard.length - 1];
      
      // Validation (basic - trust clients mostly)
      let valid = false;
      if (room.drawStack > 0) {
        // Draw stack: only same-type stack or draw — plain wild cannot override +2/+4
        valid = (card.type === '+2' && topCard.type === '+2') ||
                (card.type === '+4' && topCard.type === '+4');
      } else if (card.color === 'wild') {
        valid = true;
      } else {
        const topColor = effectiveTopColor(topCard);
        valid = card.color === topColor ||
                (card.type === topCard.type && card.type !== 'number') ||
                (card.type === 'number' && card.value === topCard.value);
      }
      
      if (!valid) {
        ws.send(JSON.stringify({type: 'invalidMove'}));
        return;
      }

      clearTurnTimer(room);
      
      // Execute play
      player.hand.splice(cardIndex, 1);
      if (card.color === 'wild') card.chosenColor = chosenColor;
      room.discard.push(card);
      
      // Handle special cards
      let skipNext = false;
      
      if (card.type === 'skip') {
        skipNext = true;
      } else if (card.type === 'reverse') {
        room.direction *= -1;
        if (room.players.length === 2) skipNext = true; // Reverse acts as skip in 2-player
      } else if (card.type === '+2') {
        room.drawStack += 2;
      } else if (card.type === '+4') {
        room.drawStack += 4;
        // Next player can stack another +4 only
      }
      
      // Check win
      if (player.hand.length === 0) {
        clearRoundTimer(room);
        clearTurnTimer(room);
        const winnerName = player.name;
        const winnerId = player.id;
        if (room.players.length <= 1) {
          broadcast(roomCode, {type: 'gameOver', winner: winnerName, final: true});
          delete rooms[roomCode];
          return;
        }
        broadcast(roomCode, {type: 'roundOver', winner: winnerName});
        room.roundTimer = setTimeout(() => {
          room.roundTimer = null;
          const r = rooms[roomCode];
          if (!r || !r.started || r.players.length < 2) return;
          startNewRound(r);
          const wi = r.players.findIndex(p => p.id === winnerId);
          if (wi >= 0) r.turn = wi;
          startTurnTimer(r, roomCode);
          broadcast(roomCode, {type: 'newRound', room: r});
        }, 4500);
        return;
      }
      
      // Advance turn
      if (!skipNext) {
        room.turn = (room.turn + room.direction + room.players.length) % room.players.length;
      } else {
        room.turn = (room.turn + 2 * room.direction + room.players.length) % room.players.length;
      }
      
      startTurnTimer(room, roomCode);
      broadcast(roomCode, {type: 'stateUpdate', room});
    }

    // DRAW CARD
    if (type === 'draw') {
      const room = rooms[roomCode];
      if (!room || !room.started) return;
      
      const player = room.players.find(p => p.id === playerId);
      const currentPlayer = room.players[room.turn];
      if (player !== currentPlayer) return;

      clearTurnTimer(room);
      if (!executeDrawForCurrentPlayer(room, roomCode)) {
        startTurnTimer(room, roomCode);
        broadcast(roomCode, {type: 'stateUpdate', room});
        return;
      }
      startTurnTimer(room, roomCode);
      broadcast(roomCode, {type: 'stateUpdate', room});
    }

    // HOST KICK PLAYER
    if (type === 'kick') {
      const room = rooms[roomCode];
      if (!room || room.hostId !== playerId) return;
      const targetId = msg.targetPlayerId;
      if (!targetId || targetId === playerId) return;
      const kickIdx = room.players.findIndex(p => p.id === targetId);
      if (kickIdx === -1) return;
      const kicked = room.players[kickIdx];
      const targetWs = kicked.ws;

      clearRoundTimer(room);
      clearTurnTimer(room);

      for (const c of kicked.hand) {
        if (c.color === 'wild') delete c.chosenColor;
      }
      room.deck.push(...kicked.hand);
      shuffle(room.deck);

      const wasCurrent = room.started && kickIdx === room.turn;
      const oldTurn = room.turn;

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

      if (room.players.length === 1) {
        const sole = room.players[0];
        broadcast(roomCode, {
          type: 'gameOver',
          winner: sole.name,
          final: true,
          reason: 'lastPlayer'
        });
        delete rooms[roomCode];
        return;
      }

      if (!room.started) {
        broadcast(roomCode, { type: 'playerLeft', playerName: kicked.name, room, reason: 'kick' });
        return;
      }

      if (!wasCurrent && kickIdx < oldTurn) {
        room.turn--;
      } else if (wasCurrent) {
        room.turn = kickIdx % room.players.length;
      }
      room.turn = ((room.turn % room.players.length) + room.players.length) % room.players.length;

      broadcast(roomCode, { type: 'playerLeft', playerName: kicked.name, room, reason: 'kick' });
      startTurnTimer(room, roomCode);
      broadcast(roomCode, { type: 'stateUpdate', room });
      return;
    }

    // LEAVE ROOM / EXIT GAME (hands go back into deck)
    if (type === 'leave') {
      const room = rooms[roomCode];
      if (!room) return;
      const leaveIdx = room.players.findIndex(p => p.id === playerId);
      if (leaveIdx === -1) return;
      const quitter = room.players[leaveIdx];
      clearRoundTimer(room);
      clearTurnTimer(room);

      for (const c of quitter.hand) {
        if (c.color === 'wild') delete c.chosenColor;
      }
      room.deck.push(...quitter.hand);
      shuffle(room.deck);

      const wasCurrent = room.started && leaveIdx === room.turn;
      const oldTurn = room.turn;

      room.players.splice(leaveIdx, 1);
      playerSockets.delete(ws);

      try {
        ws.send(JSON.stringify({type: 'leftRoom'}));
      } catch (_) {}

      if (quitter.id === room.hostId && room.players.length > 0) {
        room.hostId = room.players[0].id;
      }

      if (room.players.length === 0) {
        delete rooms[roomCode];
        return;
      }

      if (room.players.length === 1) {
        const sole = room.players[0];
        broadcast(roomCode, {
          type: 'gameOver',
          winner: sole.name,
          final: true,
          reason: 'lastPlayer'
        });
        delete rooms[roomCode];
        return;
      }

      if (!room.started) {
        broadcast(roomCode, {type: 'playerLeft', playerName: quitter.name, room});
        return;
      }

      if (!wasCurrent && leaveIdx < oldTurn) {
        room.turn--;
      } else if (wasCurrent) {
        room.turn = leaveIdx % room.players.length;
      }
      room.turn = ((room.turn % room.players.length) + room.players.length) % room.players.length;

      broadcast(roomCode, {type: 'playerLeft', playerName: quitter.name, room});
      startTurnTimer(room, roomCode);
      broadcast(roomCode, {type: 'stateUpdate', room});
      return;
    }

    // DISCONNECT HANDLING
    ws.on('close', () => {
      const info = playerSockets.get(ws);
      if (info) {
        const { roomCode, playerId } = info;
        const room = rooms[roomCode];
        if (room) {
          const player = room.players.find(p => p.id === playerId);
          if (player) {
            player.connected = false;
            broadcast(roomCode, {type: 'playerDisconnected', playerName: player.name, room});
            
            // Clean up empty rooms after 5 minutes
            setTimeout(() => {
              if (rooms[roomCode] && rooms[roomCode].players.every(p => !p.connected)) {
                delete rooms[roomCode];
              }
            }, 300000);
          }
        }
        playerSockets.delete(ws);
      }
    });
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server on ${PORT}`));