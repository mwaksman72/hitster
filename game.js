// Pure game logic: no DOM, no network. Runs in the browser (ES module) and under node --test.
// Rules: see RULES.md.

export const DEFAULTS = {
  yearFrom: 1930,
  yearTo: new Date().getFullYear(),
  languages: ['he', 'en'],
  targetCards: 10,
  players: 1,
};

export function filterSongs(songs, { yearFrom, yearTo, languages }) {
  return songs.filter(
    (s) => s.year >= yearFrom && s.year <= yearTo && languages.includes(s.lang),
  );
}

// Fisher-Yates; returns a new array.
export function shuffle(arr, rng = Math.random) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Draw order that avoids recently played songs. history = { n: games started, s: { id: game number last drawn } }.
// Songs are ranked by how long ago they were last drawn (never drawn = first, ties random), then each rank is
// blurred by +-JITTER*N so the order stays unpredictable. Returns pool order: the NEXT song is the LAST element.
export const JITTER = 0.2;
export function weightedOrder(songs, history, rng = Math.random) {
  const seen = history?.s ?? {};
  const last = (s) => (s.id in seen ? seen[s.id] : -Infinity);
  const ranked = shuffle(songs, rng).sort((a, b) => last(a) - last(b)); // stable: random among ties
  const N = ranked.length;
  return ranked
    .map((song, i) => ({ song, key: i + (rng() - 0.5) * 2 * JITTER * N }))
    .sort((a, b) => b.key - a.key)
    .map((x) => x.song);
}

// Returns a new history with `ids` marked as drawn in game number `game` (pure).
export function recordPlayed(history, ids, game) {
  const s = { ...(history?.s ?? {}) };
  for (const id of ids) s[id] = game;
  return { n: game, s };
}

// timeline is sorted by year (non-decreasing). index = insert position 0..timeline.length.
// Songs of the same year may sit on either side of each other.
export function canPlace(timeline, index, song) {
  const before = index > 0 ? timeline[index - 1] : null;
  const after = index < timeline.length ? timeline[index] : null;
  return (!before || before.year <= song.year) && (!after || song.year <= after.year);
}

function insertSorted(timeline, song) {
  const i = timeline.findIndex((s) => s.year > song.year);
  timeline.splice(i < 0 ? timeline.length : i, 0, song);
}

function validate(s) {
  if (!Number.isInteger(s.players) || s.players < 1 || s.players > 8) {
    throw new RangeError('players must be an integer 1..8');
  }
  if (!Number.isInteger(s.targetCards) || s.targetCards < 2) {
    throw new RangeError('targetCards must be an integer >= 2');
  }
  if (!Array.isArray(s.languages) || s.languages.length === 0) {
    throw new RangeError('at least one language required');
  }
  if (!(s.yearFrom <= s.yearTo)) throw new RangeError('yearFrom must be <= yearTo');
}

const newPending = () => ({ slot: null, challenger: null, challengerSlot: null });

export const START_CHALLENGES = 2;

// Each player starts with one free card (as in Hitster); targetCards counts it.
// Turn phases: 'place' -> 'placed' -> 'revealed' -> (nextTurn) -> 'place' ...
export function createGame(songs, settings = {}, rng = Math.random, history = null) {
  const s = { ...DEFAULTS, ...settings };
  validate(s);
  const pool = history ? weightedOrder(filterSongs(songs, s), history, rng) : shuffle(filterSongs(songs, s), rng);
  if (pool.length < s.players + 1) throw new Error('not enough songs for these settings');
  const players = Array.from({ length: s.players }, (_, i) => ({
    name: `Player ${i + 1}`,
    timeline: [pool.pop()],
    attempts: 0,
    correct: 0,
    challenges: s.players > 1 ? START_CHALLENGES : 0, // solo mode has no challenge cards
  }));
  return {
    settings: s,
    pool,
    players,
    turn: 0,
    current: pool.pop(),
    status: 'playing', // 'playing' | 'won' | 'exhausted'
    winners: [],
    phase: 'place', // 'place' | 'placed' | 'revealed'
    pending: newPending(),
    outcome: null,
    claimed: false,
    tiebreak: null, // { players, start }: tied contenders playing extra rounds after the final round
    finalRound: false, // someone reached the target: the remaining players of the round still get their turn
  };
}

export const activePlayer = (game) => game.players[game.turn];

function requirePhase(game, ...phases) {
  if (game.status !== 'playing') throw new Error('game is over');
  if (!phases.includes(game.phase)) throw new Error(`not allowed in phase "${game.phase}"`);
}

function checkSlot(timeline, slot) {
  if (!Number.isInteger(slot) || slot < 0 || slot > timeline.length) throw new RangeError('bad slot');
}

// Active player puts the mystery song at `slot` of their own timeline. Nothing is revealed.
// May be repeated (moving the placement) until another player challenges.
export function placeCard(game, slot) {
  requirePhase(game, 'place', 'placed');
  if (game.pending.challenger !== null) throw new Error('placement is locked by a challenge');
  checkSlot(activePlayer(game).timeline, slot);
  game.pending.slot = slot;
  game.phase = 'placed';
}

// Players (other than the active one) who hold a challenge card and may challenge now.
export function eligibleChallengers(game) {
  if (game.status !== 'playing' || game.phase !== 'placed' || game.pending.challenger !== null) return [];
  return game.players.flatMap((p, i) => (i !== game.turn && p.challenges >= 1 && (!game.tiebreak || game.tiebreak.players.includes(i)) ? [i] : []));
}

// Spends one challenge card of player `idx` (held aside until the reveal). One challenger per turn.
export function challenge(game, idx) {
  requirePhase(game, 'placed');
  if (game.pending.challenger !== null) throw new Error('already challenged this turn');
  if (!eligibleChallengers(game).includes(idx)) throw new Error('player cannot challenge');
  game.players[idx].challenges--;
  game.pending.challenger = idx;
}

export function awaitingChallengerSlot(game) {
  return game.status === 'playing' && game.phase === 'placed'
    && game.pending.challenger !== null && game.pending.challengerSlot === null;
}

// The challenger picks a slot in the ACTIVE player's timeline, different from the active player's slot.
export function challengeSlot(game, slot) {
  requirePhase(game, 'placed');
  if (!awaitingChallengerSlot(game)) throw new Error('no challenger is waiting for a slot');
  checkSlot(activePlayer(game).timeline, slot);
  if (slot === game.pending.slot) throw new RangeError('challenger must pick a different slot');
  game.pending.challengerSlot = slot;
}

// Reveal the song and resolve the turn (see the table in RULES.md). Does not advance the turn.
export function reveal(game) {
  requirePhase(game, 'placed');
  const { slot, challenger, challengerSlot } = game.pending;
  if (challenger !== null && challengerSlot === null) throw new Error('challenger has not picked a slot');

  const active = activePlayer(game);
  const song = game.current;
  const aCorrect = canPlace(active.timeline, slot, song);
  const hasChallenger = challenger !== null;
  const bCorrect = hasChallenger && canPlace(active.timeline, challengerSlot, song);

  active.attempts++;
  let awardedTo = null;
  if (aCorrect) {
    active.correct++;
    active.timeline.splice(slot, 0, song);
    awardedTo = game.turn;
  } else if (bCorrect) {
    insertSorted(game.players[challenger].timeline, song);
    awardedTo = challenger;
  }
  const challengeReturned = aCorrect && bCorrect;
  if (challengeReturned) game.players[challenger].challenges++;
  const challengeLost = hasChallenger && !bCorrect;

  if (awardedTo !== null && game.players[awardedTo].timeline.length >= game.settings.targetCards) {
    game.finalRound = true; // the game ends when the round completes (see nextTurn), so everyone plays equal turns
  }
  game.outcome = {
    song,
    player: game.turn,
    aCorrect,
    challenger: hasChallenger ? challenger : null,
    challengerCorrect: hasChallenger ? bCorrect : null,
    awardedTo,
    challengeReturned,
    challengeLost,
  };
  game.phase = 'revealed';
  return game.outcome;
}

// Honor system: after the reveal the active player says they named song and artist correctly.
export function claimChallengeCard(game) {
  requirePhase(game, 'revealed');
  if (game.players.length < 2) throw new Error('no challenge cards in solo mode');
  if (game.claimed) throw new Error('already claimed this turn');
  activePlayer(game).challenges++;
  game.claimed = true;
}

// Turn rotation: all players, or only the tied contenders once a tie-break is running.
const rotation = (game) => (game.tiebreak ? game.tiebreak.players : game.players.map((_, i) => i));
const isLastOfRound = (game) => { const r = rotation(game); return r.indexOf(game.turn) === r.length - 1; };

// What happens when the current round ends (pure; only meaningful when the round is complete and finalRound is set):
//  - exactly one player holds the target -> that player wins;
//  - several do -> a tie-break among them: full rounds are repeated until exactly one of them wins a card in a
//    round while the others do not. Returns { winners } or { tiebreak: [players] }.
function roundResult(game) {
  const len = (i) => game.players[i].timeline.length;
  if (!game.tiebreak) {
    const c = game.players.flatMap((_, i) => (len(i) >= game.settings.targetCards ? [i] : []));
    return c.length === 1 ? { winners: c } : { tiebreak: c };
  }
  const gained = game.tiebreak.players.filter((i) => len(i) > game.tiebreak.start[i]);
  return gained.length === 1 ? { winners: gained } : { tiebreak: game.tiebreak.players };
}

// True when nextTurn() will finish the game: the pool ran out, or a complete round ended with a single winner.
export function endsAfterThisTurn(game) {
  if (game.status !== 'playing') return true;
  if (game.pool.length === 0) return true;
  return game.finalRound && isLastOfRound(game) && !!roundResult(game).winners;
}

// Index of the player who plays after the current one (for the "Pass to ..." label).
export function nextPlayerIndex(game) {
  const r = rotation(game);
  if (isLastOfRound(game) && game.finalRound) {
    const res = roundResult(game);
    return res.tiebreak ? res.tiebreak[0] : game.turn;
  }
  return r[(r.indexOf(game.turn) + 1) % r.length];
}

// End the turn. After a win this is a no-op (the UI moves on to the results).
export function nextTurn(game) {
  if (game.phase !== 'revealed') throw new Error('turn is not finished');
  if (game.status !== 'playing') return;
  const next = nextPlayerIndex(game);
  if (game.finalRound && isLastOfRound(game)) {
    const res = roundResult(game);
    if (res.winners) {
      game.status = 'won';
      game.winners = res.winners;
      return;
    }
    // (re)start a tie-break round among the contenders; gains are counted from now
    game.tiebreak = { players: res.tiebreak, start: Object.fromEntries(res.tiebreak.map((i) => [i, game.players[i].timeline.length])) };
  }
  if (game.pool.length === 0) {
    game.status = game.finalRound ? 'won' : 'exhausted';
    const best = Math.max(...game.players.map((p) => p.timeline.length));
    game.winners = game.players.flatMap((p, i) => (p.timeline.length === best ? [i] : []));
    return;
  }
  game.turn = next;
  game.current = game.pool.pop();
  game.phase = 'place';
  game.pending = newPending();
  game.outcome = null;
  game.claimed = false;
}
