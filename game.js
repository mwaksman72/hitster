// Pure game logic: no DOM, no network. Runs in the browser (ES module) and under node --test.

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

// Each player starts with one free card (as in Hitster); targetCards counts it.
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
  }));
  return {
    settings: s,
    pool,
    players,
    turn: 0,
    current: pool.pop(),
    status: 'playing', // 'playing' | 'won' | 'exhausted'
    winners: [],
  };
}

// Place the current song at slot `index` of the current player's timeline.
// Correct: card is kept. Wrong: card is discarded. Turn then passes to the next player.
export function placeCard(game, index) {
  if (game.status !== 'playing') throw new Error('game is over');
  const player = game.players[game.turn];
  if (!Number.isInteger(index) || index < 0 || index > player.timeline.length) {
    throw new RangeError('bad slot');
  }
  const song = game.current;
  const correct = canPlace(player.timeline, index, song);
  player.attempts++;
  if (correct) {
    player.timeline.splice(index, 0, song);
    player.correct++;
  }
  const result = { correct, song, player: game.turn };

  if (correct && player.timeline.length >= game.settings.targetCards) {
    game.status = 'won';
    game.winners = [game.turn];
    game.current = null;
    return result;
  }
  if (game.pool.length === 0) {
    game.status = 'exhausted';
    const best = Math.max(...game.players.map((p) => p.timeline.length));
    game.winners = game.players.flatMap((p, i) => (p.timeline.length === best ? [i] : []));
    game.current = null;
    return result;
  }
  game.turn = (game.turn + 1) % game.players.length;
  game.current = game.pool.pop();
  return result;
}
