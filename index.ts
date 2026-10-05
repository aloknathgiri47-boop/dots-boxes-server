/* ============================================================
 * Dots & Boxes — Authoritative Multiplayer Server
 * ============================================================
 * Socket.io mini-service (port 3003). The server owns ALL game
 * state: every move is validated (turn, membership, bounds,
 * availability), scores and box owners are computed server-side.
 * Clients only ever send move INTENTS.
 * ============================================================ */

import { createServer } from 'http';
import { Server, type Socket } from 'socket.io';
import {
  applyMove,
  createGameState,
  edgeFromKey,
  validateMove,
} from './engine';
import type {
  BoardSize,
  GameState,
  OnlineRoomView,
  PlayerId,
} from './game-types';
import { activePlayers } from './game-types';

/* --------------------------- Room model --------------------------- */

interface PlayerSlot {
  slot: PlayerId;
  name: string;
  token: string;
  socketId: string | null;
  connected: boolean;
  disconnectTimer: ReturnType<typeof setTimeout> | null;
}

type RoomStatus = 'waiting' | 'playing' | 'finished' | 'abandoned';

interface Room {
  code: string;
  boardSize: BoardSize;
  /** Seats in this room: 2 = classic duel, 3 = three-player match. */
  playerCount: 2 | 3;
  players: PlayerSlot[]; // index 0 => p1 (host), then p2, then p3
  state: GameState | null;
  status: RoomStatus;
  rematchVotes: Set<PlayerId>;
  createdAt: number;
  lastEvent?: RoomEvent;
}

type RoomEvent =
  | { type: 'player_joined'; name: string }
  | { type: 'game_started'; rematch?: boolean }
  | { type: 'move_made'; player: PlayerId; boxes: number }
  | { type: 'game_over'; winner: PlayerId | 'draw' }
  | { type: 'opponent_disconnected'; name: string }
  | { type: 'opponent_reconnected'; name: string }
  | { type: 'opponent_left'; name: string }
  | { type: 'rematch_requested'; name: string }
  | null;

const rooms = new Map<string, Room>();
const tokenToRoom = new Map<string, string>();

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I
const RECONNECT_GRACE_MS = 60_000;
const ROOM_TTL_MS = 2 * 60 * 60_000;

function generateRoomCode(): string {
  let code: string;
  do {
    code = Array.from(
      { length: 6 },
      () => CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)],
    ).join('');
  } while (rooms.has(code));
  return code;
}

function generateToken(): string {
  return (
    Math.random().toString(36).slice(2) +
    Math.random().toString(36).slice(2) +
    Date.now().toString(36)
  );
}

function sanitizeName(raw: unknown): string {
  const name = typeof raw === 'string' ? raw.trim() : '';
  return (name || 'Player').slice(0, 18);
}

function sanitizeBoardSize(raw: unknown): BoardSize {
  return raw === 3 || raw === 4 || raw === 5 || raw === 6 || raw === 10
    ? raw
    : 4;
}

function sanitizePlayerCount(raw: unknown): 2 | 3 {
  return raw === 3 ? 3 : 2;
}

function sanitizeEdge(raw: unknown) {
  if (typeof raw !== 'string') return null;
  return edgeFromKey(raw);
}

function buildView(room: Room, token: string | null): OnlineRoomView {
  const yourSlot =
    token !== null
      ? (room.players.find((p) => p.token === token)?.slot ?? null)
      : null;
  // "opponentConnected" generalizes to 3P: every OTHER seated player
  // must be connected (for 2P this is exactly the single opponent).
  const opponentsConnected =
    yourSlot !== null
      ? room.players
          .filter((p) => p.slot !== yourSlot)
          .every((p) => p.connected)
      : false;
  return {
    code: room.code,
    status: room.status,
    boardSize: room.boardSize,
    playerCount: room.playerCount,
    players: room.players.map((p) => ({
      slot: p.slot,
      name: p.name,
      token: p.token,
      connected: p.connected,
    })),
    hostSlot: room.players[0]?.slot ?? 'p1',
    yourToken: token ?? '',
    yourSlot,
    state: room.state,
    rematchVotes: Array.from(room.rematchVotes),
    opponentConnected: opponentsConnected,
    boardSettings: { size: room.boardSize },
  };
}

function emitRoom(io: Server, room: Room): void {
  for (const p of room.players) {
    const socket = p.socketId ? io.sockets.sockets.get(p.socketId) : null;
    if (socket) {
      socket.emit('room_update', {
        view: buildView(room, p.token),
        event: room.lastEvent ?? null,
      });
    }
  }
}

function clearDisconnectTimer(p: PlayerSlot): void {
  if (p.disconnectTimer) {
    clearTimeout(p.disconnectTimer);
    p.disconnectTimer = null;
  }
}

/* --------------------------- Cleanup --------------------------- */

setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    const anyConnected = room.players.some((p) => p.connected);
    if (!anyConnected && now - room.createdAt > ROOM_TTL_MS) {
      rooms.delete(code);
      for (const p of room.players) tokenToRoom.delete(p.token);
      console.log(`[cleanup] removed stale room ${code}`);
    }
  }
}, 5 * 60_000).unref?.();

/* --------------------------- Socket wiring --------------------------- */

const httpServer = createServer();
const io = new Server(httpServer, {
  // DO NOT change the path, it is used by Caddy to forward the request
  path: '/',
  cors: { origin: '*', methods: ['GET', 'POST'] },
  pingTimeout: 60000,
  pingInterval: 25000,
});

io.on('connection', (socket: Socket) => {
  console.log(`[conn] ${socket.id}`);

  const findRoomByToken = (token: string): Room | null => {
    const code = tokenToRoom.get(token);
    if (!code) return null;
    return rooms.get(code) ?? null;
  };

  const bindPlayer = (room: Room, token: string): PlayerSlot | null => {
    const p = room.players.find((pl) => pl.token === token);
    if (!p) return null;
    p.socketId = socket.id;
    p.connected = true;
    clearDisconnectTimer(p);
    socket.data.token = token;
    socket.data.roomCode = room.code;
    void socket.join(room.code);
    return p;
  };

  socket.on(
    'create_room',
    (data: {
      name?: string;
      boardSize?: number;
      playerCount?: number;
    }) => {
      const name = sanitizeName(data?.name);
      const playerCount = sanitizePlayerCount(data?.playerCount);
      // Three-player rooms follow the local 3P setup: boards 3–6 only.
      let boardSize = sanitizeBoardSize(data?.boardSize);
      if (playerCount === 3 && boardSize === 10) boardSize = 6;
      const code = generateRoomCode();
      const token = generateToken();
      const room: Room = {
        code,
        boardSize,
        playerCount,
        players: [
          { slot: 'p1', name, token, socketId: socket.id, connected: true, disconnectTimer: null },
        ],
        state: null,
        status: 'waiting',
        rematchVotes: new Set(),
        createdAt: Date.now(),
        lastEvent: null,
      };
      rooms.set(code, room);
      tokenToRoom.set(token, code);
      socket.data.token = token;
      socket.data.roomCode = code;
      void socket.join(code);
      socket.emit('room_update', {
        view: buildView(room, token),
        event: null,
      });
      console.log(
        `[room] created ${code} by ${name} (${playerCount}P, ${boardSize}x${boardSize})`,
      );
    },
  );

  socket.on('join_room', (data: { code?: string; name?: string }) => {
    const code = (typeof data?.code === 'string' ? data.code : '')
      .trim()
      .toUpperCase();
    const name = sanitizeName(data?.name);
    const room = rooms.get(code);
    if (!room) {
      socket.emit('server_error', {
        message: 'Room not found. Please check the room code.',
        code: 'ROOM_NOT_FOUND',
      });
      return;
    }
    if (room.players.length >= room.playerCount) {
      socket.emit('server_error', {
        message: 'Room is full. Ask the host to create a new room.',
        code: 'ROOM_FULL',
      });
      return;
    }
    // First free seat in round-robin order: p2 joins any room, p3 only 3P.
    const takenSlots = new Set(room.players.map((p) => p.slot));
    const slot = activePlayers(room.playerCount).find((s) => !takenSlots.has(s));
    if (!slot) {
      socket.emit('server_error', {
        message: 'Room is full. Ask the host to create a new room.',
        code: 'ROOM_FULL',
      });
      return;
    }
    const token = generateToken();
    room.players.push({
      slot,
      name,
      token,
      socketId: socket.id,
      connected: true,
      disconnectTimer: null,
    });
    tokenToRoom.set(token, code);
    socket.data.token = token;
    socket.data.roomCode = code;
    void socket.join(code);
    room.lastEvent = { type: 'player_joined', name };
    emitRoom(io, room);
    console.log(`[room] ${name} joined ${code}`);
  });

  socket.on('reconnect_session', (data: { code?: string; token?: string }) => {
    const token = typeof data?.token === 'string' ? data.token : '';
    if (!token) return;
    const room = findRoomByToken(token);
    if (!room) {
      socket.emit('session_lost', {
        message: 'Your previous room is no longer available.',
      });
      return;
    }
    const p = bindPlayer(room, token);
    if (!p) {
      socket.emit('session_lost', {
        message: 'Your previous room is no longer available.',
      });
      return;
    }
    room.lastEvent = { type: 'opponent_reconnected', name: p.name };
    emitRoom(io, room);
    console.log(`[room] ${p.name} reconnected to ${room.code}`);
  });

  socket.on('start_game', () => {
    const token = socket.data.token as string | undefined;
    const room = token ? findRoomByToken(token) : null;
    if (!room || room.status !== 'waiting') return;
    const me = room.players.find((p) => p.token === token);
    if (!me || room.players[0]?.token !== token) return; // host only
    // Every seat must be filled (2 for a duel, 3 for a three-player room).
    if (room.players.length < room.playerCount) return;
    room.state = createGameState(room.boardSize, room.playerCount);
    room.status = 'playing';
    room.rematchVotes.clear();
    room.lastEvent = { type: 'game_started' };
    emitRoom(io, room);
    console.log(`[room] game started in ${room.code} (${room.playerCount}P)`);
  });

  socket.on('make_move', (data: { edge?: string }) => {
    const token = socket.data.token as string | undefined;
    const room = token ? findRoomByToken(token) : null;
    if (!room || !room.state || room.status !== 'playing') return;
    const me = room.players.find((p) => p.token === token);
    if (!me) return;

    const edge = sanitizeEdge(data?.edge);
    if (!edge) {
      socket.emit('server_error', { message: 'Invalid move.', code: 'BAD_EDGE' });
      return;
    }

    // Server-side validation: identity, turn, bounds, availability.
    const check = validateMove(room.state, edge, me.slot);
    if (!check.valid) {
      socket.emit('server_error', {
        message:
          check.reason === "It is not this player's turn."
            ? "It's not your turn."
            : check.reason ?? 'Invalid move.',
        code: 'INVALID_MOVE',
      });
      return;
    }

    const result = applyMove(room.state, edge, me.slot);
    room.state = result.state;
    room.lastEvent = {
      type: 'move_made',
      player: me.slot,
      boxes: result.completedBoxes.length,
    };
    if (result.state.status === 'finished') {
      room.status = 'finished';
      room.lastEvent = {
        type: 'game_over',
        winner: result.state.winner as PlayerId | 'draw',
      };
    }
    emitRoom(io, room);
  });

  socket.on('rematch_vote', () => {
    const token = socket.data.token as string | undefined;
    const room = token ? findRoomByToken(token) : null;
    if (!room) return;
    const me = room.players.find((p) => p.token === token);
    if (!me) return;
    if (room.status !== 'finished' && room.status !== 'abandoned') return;
    room.rematchVotes.add(me.slot);
    // Rematch needs EVERY seat to vote (2 votes for 2P, 3 votes for 3P).
    if (room.rematchVotes.size >= room.playerCount) {
      room.state = createGameState(room.boardSize, room.playerCount);
      room.status = 'playing';
      room.rematchVotes.clear();
      room.lastEvent = { type: 'game_started', rematch: true };
    } else {
      room.lastEvent = { type: 'rematch_requested', name: me.name };
    }
    emitRoom(io, room);
  });

  socket.on('leave_room', () => {
    const token = socket.data.token as string | undefined;
    if (!token) return;
    const room = findRoomByToken(token);
    if (!room) return;
    const me = room.players.find((p) => p.token === token);
    if (!me) return;
    clearDisconnectTimer(me);
    me.connected = false;
    me.socketId = null;
    room.lastEvent = { type: 'opponent_left', name: me.name };
    if (room.status === 'playing') room.status = 'abandoned';
    emitRoom(io, room);
    void socket.leave(room.code);
    console.log(`[room] ${me.name} left ${room.code}`);
  });

  socket.on('disconnect', (reason: string) => {
    console.log(`[disc] ${socket.id} (${reason})`);
    const token = socket.data.token as string | undefined;
    if (!token) return;
    const room = findRoomByToken(token);
    if (!room) return;
    const me = room.players.find((p) => p.token === token);
    if (!me || me.socketId !== socket.id) return;

    me.connected = false;
    me.socketId = null;
    room.lastEvent = { type: 'opponent_disconnected', name: me.name };
    emitRoom(io, room);

    clearDisconnectTimer(me);
    me.disconnectTimer = setTimeout(() => {
      const still = rooms.get(room.code);
      if (!still) return;
      const slot = still.players.find((p) => p.token === token);
      if (!slot || slot.connected) return;
      still.lastEvent = { type: 'opponent_left', name: slot.name };
      if (still.status === 'playing') still.status = 'abandoned';
      emitRoom(io, still);
      console.log(`[room] ${slot.name} timed out from ${room.code}`);
    }, RECONNECT_GRACE_MS);
  });

  socket.on('error', (err: unknown) => {
    console.error(`[err] ${socket.id}`, err);
  });
});

const PORT = Number(process.env.PORT) || 3003;
httpServer.listen(PORT, () => {
  console.log(`Dots & Boxes multiplayer server running on port ${PORT}`);
});

process.on('SIGTERM', () => {
  httpServer.close(() => process.exit(0));
});
process.on('SIGINT', () => {
  httpServer.close(() => process.exit(0));
});
