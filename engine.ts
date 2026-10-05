/* ============================================================
 * Dots & Boxes — Pure Game Engine
 * ============================================================
 * All functions are pure / immutable-friendly so the same logic
 * can run on the client (local & cpu modes) and on the
 * authoritative multiplayer server.
 *
 * Golden rule: completing a box keeps the current player's turn.
 * ============================================================ */

import type {
  BoardSize,
  BoxRef,
  EdgeRef,
  GameState,
  MoveResult,
  PlayerId,
  WinnerValue,
} from './game-types';
import { activePlayers } from './game-types';

/* ---------------------- Edge helpers ---------------------- */

export function edgeKey(e: EdgeRef): string {
  return `${e.orient}-${e.r}-${e.c}`;
}

export function edgeFromKey(key: string): EdgeRef | null {
  const parts = key.split('-');
  if (parts.length !== 3) return null;
  const orient = parts[0];
  if (orient !== 'h' && orient !== 'v') return null;
  const r = Number(parts[1]);
  const c = Number(parts[2]);
  if (!Number.isInteger(r) || !Number.isInteger(c)) return null;
  return { orient, r, c };
}

export function isEdgeAvailable(state: GameState, e: EdgeRef): boolean {
  const { n } = state;
  if (e.orient === 'h') {
    return (
      e.r >= 0 && e.r <= n && e.c >= 0 && e.c < n && !state.hEdges[e.r][e.c]
    );
  }
  return (
    e.r >= 0 && e.r < n && e.c >= 0 && e.c <= n && !state.vEdges[e.r][e.c]
  );
}

export function totalAvailableEdges(n: number): number {
  return 2 * n * (n + 1);
}

/** Boxes adjacent to an edge (boxes that share this edge). */
export function adjacentBoxes(state: GameState, e: EdgeRef): BoxRef[] {
  const { n } = state;
  const boxes: BoxRef[] = [];
  if (e.orient === 'h') {
    if (e.r > 0) boxes.push({ r: e.r - 1, c: e.c });
    if (e.r < n) boxes.push({ r: e.r, c: e.c });
  } else {
    if (e.c > 0) boxes.push({ r: e.r, c: e.c - 1 });
    if (e.c < n) boxes.push({ r: e.r, c: e.c });
  }
  return boxes;
}

/** Number of drawn sides of a box. */
export function boxSideCount(state: GameState, b: BoxRef): number {
  let count = 0;
  if (state.hEdges[b.r][b.c]) count++; // top
  if (state.hEdges[b.r + 1][b.c]) count++; // bottom
  if (state.vEdges[b.r][b.c]) count++; // left
  if (state.vEdges[b.r][b.c + 1]) count++; // right
  return count;
}

/** The single missing edge of a 3-sided box, or null. */
export function missingEdgeOfBox(state: GameState, b: BoxRef): EdgeRef | null {
  if (state.hEdges[b.r][b.c] === false) return { orient: 'h', r: b.r, c: b.c };
  if (state.hEdges[b.r + 1][b.c] === false)
    return { orient: 'h', r: b.r + 1, c: b.c };
  if (state.vEdges[b.r][b.c] === false) return { orient: 'v', r: b.r, c: b.c };
  if (state.vEdges[b.r][b.c + 1] === false)
    return { orient: 'v', r: b.r, c: b.c + 1 };
  return null;
}

export function isBoxComplete(state: GameState, b: BoxRef): boolean {
  return boxSideCount(state, b) === 4;
}

/* ---------------------- State creation ---------------------- */

export function createGameState(n: BoardSize, playerCount: 2 | 3 = 2): GameState {
  const hEdges: boolean[][] = Array.from({ length: n + 1 }, () =>
    Array<boolean>(n).fill(false),
  );
  const vEdges: boolean[][] = Array.from({ length: n }, () =>
    Array<boolean>(n + 1).fill(false),
  );
  const hOwner: (PlayerId | null)[][] = Array.from({ length: n + 1 }, () =>
    Array<PlayerId | null>(n).fill(null),
  );
  const vOwner: (PlayerId | null)[][] = Array.from({ length: n }, () =>
    Array<PlayerId | null>(n + 1).fill(null),
  );
  const boxOwner: (PlayerId | null)[][] = Array.from({ length: n }, () =>
    Array<PlayerId | null>(n).fill(null),
  );
  return {
    n,
    playerCount,
    hEdges,
    vEdges,
    hOwner,
    vOwner,
    boxOwner,
    scores: { p1: 0, p2: 0, p3: 0 },
    current: 'p1',
    status: 'playing',
    winner: null,
    movesPlayed: 0,
    lastEdge: null,
    lastCompletedBoxes: [],
    lastPlayer: null,
  };
}

/** Defensive read: states saved before 3-player support may lack the
 *  field (undefined) — treat anything but 3 as the classic 2-player game. */
export function playerCountOf(state: GameState): 2 | 3 {
  return state.playerCount === 3 ? 3 : 2;
}

export function cloneGameState(state: GameState): GameState {
  return {
    n: state.n,
    playerCount: playerCountOf(state),
    hEdges: state.hEdges.map((row) => [...row]),
    vEdges: state.vEdges.map((row) => [...row]),
    hOwner: state.hOwner.map((row) => [...row]),
    vOwner: state.vOwner.map((row) => [...row]),
    boxOwner: state.boxOwner.map((row) => [...row]),
    scores: {
      p1: state.scores.p1,
      p2: state.scores.p2,
      p3: state.scores.p3 ?? 0,
    },
    current: state.current,
    status: state.status,
    winner: state.winner,
    movesPlayed: state.movesPlayed,
    lastEdge: state.lastEdge ? { ...state.lastEdge } : null,
    lastCompletedBoxes: state.lastCompletedBoxes.map((b) => ({ ...b })),
    lastPlayer: state.lastPlayer,
  };
}

/** A shallow "view" copy that reuses matrices (for renders / memo). */
export function snapshotState(state: GameState): GameState {
  return { ...state };
}

/* ---------------------- Turn & winner helpers ---------------------- */

/**
 * The player who moves after `current` in round-robin order.
 * 2 players: p1 -> p2 -> p1…  3 players: p1 -> p2 -> p3 -> p1…
 * This replaces any two-player arithmetic ("1 - index") so the
 * rotation stays correct for every player count.
 */
export function nextPlayerId(
  current: PlayerId,
  playerCount: 2 | 3,
): PlayerId {
  const order = activePlayers(playerCount);
  const idx = order.indexOf(current);
  // Unknown id falls back to the first player (defensive).
  if (idx < 0) return order[0];
  return order[(idx + 1) % order.length];
}

/**
 * Winner for a finished game: the unique leader wins; a tie at the top
 * is a draw (two-way, or three-way when all players tie).
 */
export function computeWinner(
  scores: Record<PlayerId, number>,
  playerCount: 2 | 3,
): WinnerValue {
  const order = activePlayers(playerCount);
  const max = Math.max(...order.map((p) => scores[p]));
  const leaders = order.filter((p) => scores[p] === max);
  return leaders.length === 1 ? leaders[0] : 'draw';
}

/* ---------------------- Validation ---------------------- */

export interface MoveCheck {
  valid: boolean;
  reason?: string;
}

export function validateMove(
  state: GameState,
  e: EdgeRef,
  player: PlayerId,
): MoveCheck {
  if (state.status !== 'playing') {
    return { valid: false, reason: 'The game is not active.' };
  }
  if (state.current !== player) {
    return { valid: false, reason: "It is not this player's turn." };
  }
  const { n } = state;
  const inBounds =
    e.orient === 'h'
      ? e.r >= 0 && e.r <= n && e.c >= 0 && e.c < n
      : e.r >= 0 && e.r < n && e.c >= 0 && e.c <= n;
  if (!inBounds) {
    return { valid: false, reason: 'Invalid edge coordinates.' };
  }
  if (!isEdgeAvailable(state, e)) {
    return { valid: false, reason: 'That line is already taken.' };
  }
  return { valid: true };
}

/* ---------------------- Applying moves ---------------------- */

/**
 * Applies a move for the given player.
 * Returns a NEW state (input untouched) plus validity info.
 * Golden rule handled here: box completion keeps the turn.
 */
export function applyMove(
  prevState: GameState,
  e: EdgeRef,
  player: PlayerId,
): MoveResult {
  const check = validateMove(prevState, e, player);
  if (!check.valid) {
    return {
      state: prevState,
      valid: false,
      reason: check.reason,
      completedBoxes: [],
    };
  }

  const state = cloneGameState(prevState);
  const mover = state.current; // authoritative: current player

  // 1. Draw the edge
  if (e.orient === 'h') {
    state.hEdges[e.r][e.c] = true;
    state.hOwner[e.r][e.c] = mover;
  } else {
    state.vEdges[e.r][e.c] = true;
    state.vOwner[e.r][e.c] = mover;
  }
  state.movesPlayed += 1;

  // 2/3/4. Find neighboring boxes and check completion
  const completed: BoxRef[] = [];
  for (const box of adjacentBoxes(state, e)) {
    // 5th rule: a completed box can only ever be claimed once
    if (state.boxOwner[box.r][box.c] !== null) continue;
    if (isBoxComplete(state, box)) {
      state.boxOwner[box.r][box.c] = mover;
      completed.push(box);
    }
  }

  // 6. Score
  if (completed.length > 0) {
    state.scores[mover] += completed.length;
  }

  // 7. Turn: keep on completion, otherwise pass to the NEXT player in
  //    round-robin order ((index + 1) % playerCount). Never a 2-player swap.
  if (completed.length === 0) {
    state.current = nextPlayerId(mover, playerCountOf(state));
  }

  state.lastEdge = { ...e };
  state.lastCompletedBoxes = completed;
  state.lastPlayer = mover;

  // 8/9. Game completion: every box claimed -> finished. The leader wins;
  //    a tie at the top is a draw (two-way or three-way).
  const totalBoxes = state.n * state.n;
  const claimed = activePlayers(playerCountOf(state)).reduce(
    (sum, p) => sum + (state.scores[p] ?? 0),
    0,
  ); // invariant: equals completed boxes
  if (claimed >= totalBoxes) {
    state.status = 'finished';
    state.winner = computeWinner(state.scores, playerCountOf(state));
  }

  return { state, valid: true, completedBoxes: completed };
}

/** All currently available edges. */
export function availableEdges(state: GameState): EdgeRef[] {
  const { n } = state;
  const edges: EdgeRef[] = [];
  for (let r = 0; r <= n; r++)
    for (let c = 0; c < n; c++)
      if (!state.hEdges[r][c]) edges.push({ orient: 'h', r, c });
  for (let r = 0; r < n; r++)
    for (let c = 0; c <= n; c++)
      if (!state.vEdges[r][c]) edges.push({ orient: 'v', r, c });
  return edges;
}

/** Boxes that are 3-sided and unclaimed (immediately capturable). */
export function capturableBoxes(state: GameState): BoxRef[] {
  const boxes: BoxRef[] = [];
  for (let r = 0; r < state.n; r++)
    for (let c = 0; c < state.n; c++)
      if (state.boxOwner[r][c] === null && boxSideCount(state, { r, c }) === 3)
        boxes.push({ r, c });
  return boxes;
}

/**
 * Simulates: draw `firstEdge`, then greedily complete every capturable
 * box (chain reaction) until none remain. Returns the boxes captured and
 * the edges used. Used by AI for chain-length estimation.
 */
export function simulateGreedyCapture(
  state: GameState,
  firstEdge: EdgeRef,
): { boxes: BoxRef[]; edges: EdgeRef[]; stateAfter: GameState } {
  const sim = cloneGameState(state);
  const capturedBoxes: BoxRef[] = [];
  const usedEdges: EdgeRef[] = [];

  const draw = (edge: EdgeRef) => {
    if (edge.orient === 'h') sim.hEdges[edge.r][edge.c] = true;
    else sim.vEdges[edge.r][edge.c] = true;
    usedEdges.push(edge);
    for (const box of adjacentBoxes(sim, edge)) {
      if (sim.boxOwner[box.r][box.c] !== null) continue;
      if (isBoxComplete(sim, box)) {
        sim.boxOwner[box.r][box.c] = 'p1'; // owner irrelevant for simulation
        capturedBoxes.push(box);
      }
    }
  };

  draw(firstEdge);

  let guard = 0;
  while (guard++ < 1000) {
    const capturable = capturableBoxes(sim);
    if (capturable.length === 0) break;
    const box = capturable[0];
    const edge = missingEdgeOfBox(sim, box);
    if (!edge) break;
    draw(edge);
  }

  return { boxes: capturedBoxes, edges: usedEdges, stateAfter: sim };
}

/**
 * Groups capturable boxes into connected "open chains" (BFS over boxes
 * that are capturable now or become capturable as the chain is eaten).
 * Returns the size of the chain reachable from the current capturable
 * boxes, plus a representative opening move. Only used by the AI.
 */
export function currentChainInfo(state: GameState): {
  length: number;
  anyCapturable: boolean;
} {
  const capturable = capturableBoxes(state);
  if (capturable.length === 0) return { length: 0, anyCapturable: false };

  // Greedy simulation covers the full reachable capture set.
  const first = capturable[0];
  const missing = missingEdgeOfBox(state, first);
  if (!missing) return { length: 0, anyCapturable: true };
  const sim = simulateGreedyCapture(state, missing);
  return { length: sim.boxes.length, anyCapturable: true };
}
