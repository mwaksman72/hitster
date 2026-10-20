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

// Each player starts with one free card (as in Hitster); targetCards counts it.
// Turn phases: 'place' -> 'placed' -> 'revealed' -> (nextTurn) -> 'place' ...
export function createGame(songs, settings = {}, rng = Math.random) {
  const s = { ...DEFAULTS, ...settings };
  validate(s);
  const pool = shuffle(filterSongs(songs, s), rng);
  if (pool.length < s.players + 1) throw new Error('not enough songs for these settings');
  const players = Array.from({ length: s.players }, (_, i) => ({
    name: `Player ${i + 1}`,
    timeline: [pool.pop()],
    attempts: 0,
    correct: 0,
    challenges: 0,
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
  return game.players.flatMap((p, i) => (i !== game.turn && p.challenges >= 1 ? [i] : []));
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
    game.status = 'won';
    game.winners = [awardedTo];
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

// End the turn. After a win this is a no-op (the UI moves on to the results).
export function nextTurn(game) {
  if (game.phase !== 'revealed') throw new Error('turn is not finished');
  if (game.status !== 'playing') return;
  if (game.pool.length === 0) {
    game.status = 'exhausted';
    const best = Math.max(...game.players.map((p) => p.timeline.length));
    game.winners = game.players.flatMap((p, i) => (p.timeline.length === best ? [i] : []));
    return;
  }
  game.turn = (game.turn + 1) % game.players.length;
  game.current = game.pool.pop();
  game.phase = 'place';
  game.pending = newPending();
  game.outcome = null;
  game.claimed = false;
}
