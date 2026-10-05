/* ============================================================
 * Dots & Boxes — Core Types
 * ============================================================
 * Board model:
 *   - N x N boxes  =>  (N+1) x (N+1) dots
 *   - Horizontal edges: hEdges[r][c] connects dot(r,c) -> dot(r,c+1)
 *       r in [0..N], c in [0..N-1]
 *   - Vertical edges:   vEdges[r][c] connects dot(r,c) -> dot(r+1,c)
 *       r in [0..N-1], c in [0..N]
 * ============================================================ */

export type PlayerId = 'p1' | 'p2' | 'p3';

/** Canonical turn order. A game with playerCount 2 uses [p1, p2];
 *  playerCount 3 uses all three (round-robin p1 -> p2 -> p3 -> p1). */
export const PLAYER_ORDER: readonly PlayerId[] = ['p1', 'p2', 'p3'] as const;

export function activePlayers(playerCount: 2 | 3): readonly PlayerId[] {
  return PLAYER_ORDER.slice(0, playerCount);
}

export type GameMode = 'local' | 'cpu' | 'online';

export type Difficulty = 'easy' | 'medium' | 'hard';

export type BoardSize = 3 | 4 | 5 | 6 | 10;

/** Reference to a single edge on the board. */
export interface EdgeRef {
  orient: 'h' | 'v';
  r: number;
  c: number;
}

/** Reference to a single box (r, c are box coordinates, not dot coordinates). */
export interface BoxRef {
  r: number;
  c: number;
}

export type GameStatus = 'playing' | 'finished';

export type WinnerValue = PlayerId | 'draw' | null;

export interface PlayerInfo {
  id: PlayerId;
  name: string;
  isComputer: boolean;
}

/** Serializable game state — the single source of truth for a match. */
export interface GameState {
  n: BoardSize; // boxes per side
  /** 2 = classic duel, 3 = three-player round-robin. */
  playerCount: 2 | 3;
  hEdges: boolean[][]; // (n+1) rows x n cols
  vEdges: boolean[][]; // n rows x (n+1) cols
  /** Who drew each edge (for rendering line colors). */
  hOwner: (PlayerId | null)[][]; // (n+1) rows x n cols
  vOwner: (PlayerId | null)[][]; // n rows x (n+1) cols
  boxOwner: (PlayerId | null)[][]; // n x n
  scores: Record<PlayerId, number>;
  current: PlayerId;
  status: GameStatus;
  winner: WinnerValue;
  movesPlayed: number;
  /** Last applied edge (for line draw animation). */
  lastEdge: EdgeRef | null;
  /** Boxes completed by the last edge (for fill animation). */
  lastCompletedBoxes: BoxRef[];
  /** Player who drew lastEdge. */
  lastPlayer: PlayerId | null;
}

/** Result of applying a move. */
export interface MoveResult {
  state: GameState;
  valid: boolean;
  reason?: string;
  completedBoxes: BoxRef[];
}

/* ------------------------- Settings ------------------------- */

export type ThemePreference = 'light' | 'dark' | 'system';

export interface GameSettings {
  sound: boolean;
  music: boolean;
  animations: boolean;
  vibration: boolean;
  theme: ThemePreference;
}

export const DEFAULT_SETTINGS: GameSettings = {
  sound: true,
  music: false,
  animations: true,
  vibration: true,
  theme: 'system',
};

/* ------------------------- Statistics ------------------------- */

export interface Stats {
  gamesPlayed: number;
  wins: number;
  losses: number;
  draws: number;
  totalBoxesClaimed: number;
  bestScore: number;
  /** 3-player local games (tracked separately: win rate only counts 1v1). */
  threePlayerGames: number;
  threePlayerDraws: number;
  /** per-mode breakdown */
  byMode: Record<
    GameMode,
    { played: number; wins: number; losses: number; draws: number }
  >;
}

export function emptyStats(): Stats {
  return {
    gamesPlayed: 0,
    wins: 0,
    losses: 0,
    draws: 0,
    totalBoxesClaimed: 0,
    bestScore: 0,
    threePlayerGames: 0,
    threePlayerDraws: 0,
    byMode: {
      local: { played: 0, wins: 0, losses: 0, draws: 0 },
      cpu: { played: 0, wins: 0, losses: 0, draws: 0 },
      online: { played: 0, wins: 0, losses: 0, draws: 0 },
    },
  };
}

/* ------------------------- Move intent (online) ------------------------- */

export function serializeEdge(e: EdgeRef): string {
  return `${e.orient}-${e.r}-${e.c}`;
}

/* ------------------------- Online protocol ------------------------- */

export interface OnlinePlayerSlot {
  slot: PlayerId;
  name: string;
  token: string;
  connected: boolean;
}

export type OnlineRoomStatus = 'waiting' | 'playing' | 'finished' | 'abandoned';

export interface OnlineRoomView {
  code: string;
  status: OnlineRoomStatus;
  boardSize: BoardSize;
  /** Seats in this room: 2 = duel, 3 = three-player match. */
  playerCount: 2 | 3;
  players: OnlinePlayerSlot[];
  hostSlot: PlayerId;
  yourToken: string;
  yourSlot: PlayerId | null;
  state: GameState | null;
  rematchVotes: PlayerId[];
  /** True when EVERY other seated player is connected (2P or 3P). */
  opponentConnected: boolean;
  boardSettings: { size: BoardSize };
}

export type ServerErrorEvent = {
  message: string;
  code?: string;
};
