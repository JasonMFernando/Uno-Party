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

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function generateCode() {
  return Math.random().toString(36).substring(2, 7).toUpperCase();
}

function broadcast(roomCode, message, excludeWs = null) {
  wss.clients.forEach(ws => {
    const info = playerSockets.get(ws);
    if (info && info.roomCode === roomCode && ws !== excludeWs && ws.readyState === 1) {
      ws.send(JSON.stringify(message));
    }
  });
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
          ws.send(JSON.stringify({type: 'reconnected', room, you: player}));
          broadcast(roomCode, {type: 'playerReconnected', playerName: player.name});
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
          connected: true,
          saidUno: false
        }],
        deck: [],
        discard: [],
        started: false,
        turn: 0,
        direction: 1,
        drawStack: 0 // For stacking +2/+4
      };
      playerSockets.set(ws, {roomCode: code, playerId: newPlayerId});
      ws.send(JSON.stringify({type: 'created', roomCode: code, playerId: newPlayerId, room: rooms[code]}));
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
      if (room.players.length >= 6) {
        ws.send(JSON.stringify({type: 'error', message: 'Room full (max 6)'}));
        return;
      }
      const newPlayerId = Math.random().toString(36).substring(2, 10);
      const player = {
        id: newPlayerId,
        name: playerName,
        hand: [],
        ws,
        connected: true,
        saidUno: false
      };
      room.players.push(player);
      playerSockets.set(ws, {roomCode, playerId: newPlayerId});
      ws.send(JSON.stringify({type: 'joined', playerId: newPlayerId, room}));
      broadcast(roomCode, {type: 'playerJoined', player}, ws);
    }

    // START GAME
    if (type === 'start') {
      const room = rooms[roomCode];
      if (!room || room.hostId !== playerId || room.players.length < 2) return;
      
      room.started = true;
      room.deck = createDeck();
      room.discard = [room.deck.pop()]; // Starting card
      
      // Deal 7 cards each
      for (const p of room.players) {
        p.hand = room.deck.splice(0, 7);
      }
      
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
      if (card.color === 'wild') {
        valid = true; // Wild can always play
      } else if (room.drawStack > 0) {
        // Must stack if possible
        valid = (card.type === '+2' && topCard.type === '+2') || 
                (card.type === '+4' && topCard.type === '+4');
      } else {
        // Normal play: match color or type/value
        valid = card.color === topCard.color || 
                (card.type === topCard.type && card.type !== 'number') ||
                (card.type === 'number' && card.value === topCard.value);
      }
      
      if (!valid) {
        ws.send(JSON.stringify({type: 'invalidMove'}));
        return;
      }
      
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
        broadcast(roomCode, {type: 'gameOver', winner: player.name});
        delete rooms[roomCode];
        return;
      }
      
      // Check UNO penalty
      if (player.hand.length === 1 && !player.saidUno) {
        // Forgot to say UNO! Draw 2 penalty
        const penalty = room.deck.splice(0, 2);
        player.hand.push(...penalty);
        broadcast(roomCode, {type: 'unoPenalty', player: player.name});
      }
      player.saidUno = false; // Reset for next turn
      
      // Advance turn
      if (!skipNext) {
        room.turn = (room.turn + room.direction + room.players.length) % room.players.length;
      } else {
        room.turn = (room.turn + 2 * room.direction + room.players.length) % room.players.length;
      }
      
      broadcast(roomCode, {type: 'stateUpdate', room});
    }

    // SAY UNO
    if (type === 'uno') {
      const room = rooms[roomCode];
      const player = room?.players.find(p => p.id === playerId);
      if (player && player.hand.length === 2) { // Can only say UNO when 2 cards left (about to play 1)
        player.saidUno = true;
        broadcast(roomCode, {type: 'saidUno', player: player.name});
      }
    }

    // DRAW CARD
    if (type === 'draw') {
      const room = rooms[roomCode];
      if (!room || !room.started) return;
      
      const player = room.players.find(p => p.id === playerId);
      const currentPlayer = room.players[room.turn];
      if (player !== currentPlayer) return;
      
      // If stack active, must draw all
      const drawCount = room.drawStack > 0 ? room.drawStack : 1;
      
      // Replenish deck if needed
      if (room.deck.length < drawCount) {
        const bottom = room.discard.slice(0, -1);
        room.deck.push(...shuffle(bottom));
        room.discard = [room.discard[room.discard.length - 1]];
      }
      
      const drawn = room.deck.splice(0, drawCount);
      player.hand.push(...drawn);
      room.drawStack = 0; // Clear stack
      
      // Turn passes
      room.turn = (room.turn + room.direction + room.players.length) % room.players.length;
      
      broadcast(roomCode, {type: 'stateUpdate', room});
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
            broadcast(roomCode, {type: 'playerDisconnected', playerName: player.name});
            
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