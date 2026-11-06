import {
  activePlayer, awaitingChallengerSlot, challenge, challengeSlot, claimChallengeCard,
  createGame, eligibleChallengers, endsAfterThisTurn, nextPlayerIndex, nextTurn, placeCard, recordPlayed, reveal,
} from './game.js';

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};
const audio = $('audio');

// Diagnostics are console-only (no visible UI).
const dlog = (msg) => console.log(msg);

// ---------- preview resolution ----------
const PREVIEW_HOST = 'audio-ssl.itunes.apple.com'; // keep in sync with CSP media-src

function allowedPreview(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && u.hostname === PREVIEW_HOST;
  } catch {
    return false;
  }
}

async function fetchTimeout(url, ms) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    return await fetch(url, { signal: ctl.signal });
  } finally {
    clearTimeout(t);
  }
}

// A track may exist in only one storefront (e.g. "diva" is US-only), so try both.
async function lookup(song) {
  const countries = song.lang === 'he' ? ['IL', 'US'] : ['US', 'IL'];
  for (const country of countries) {
    const r = await fetchTimeout(
      `https://itunes.apple.com/lookup?id=${encodeURIComponent(song.itunesTrackId)}&country=${country}`, 5000);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const url = (await r.json()).results?.[0]?.previewUrl;
    if (url) return url;
  }
  throw new Error('no previewUrl in either storefront');
}

async function resolvePreview(song) {
  if (song.itunesTrackId) {
    const t0 = performance.now();
    try {
      const url = await lookup(song);
      if (!allowedPreview(url)) throw new Error('unexpected preview host');
      dlog(`lookup ok ${song.id} ${Math.round(performance.now() - t0)}ms ` +
        (url === song.previewUrl ? '(same as stored)' : '(DIFFERS from stored)'));
      return url;
    } catch (e) {
      dlog(`lookup FAIL ${song.id}: ${e.name}: ${e.message}`);
    }
  }
  if (song.previewUrl && allowedPreview(song.previewUrl)) {
    dlog(`using stored url ${song.id}`);
    return song.previewUrl;
  }
  return null;
}

// The URL is resolved when a turn starts, so play() can run synchronously in the tap handler
// (iOS may reject play() after an await, i.e. once the user-gesture is considered stale).
let prep = { id: null, url: null, state: 'idle' }; // state: idle | resolving | ready | failed

async function prepare(song) {
  const mine = (prep = { id: song.id, url: null, state: 'resolving' });
  audio.removeAttribute('src');
  setPlayState();
  const url = await resolvePreview(song);
  if (prep !== mine) return; // turn moved on
  mine.url = url;
  mine.state = url ? 'ready' : 'failed';
  if (url) audio.src = url;
  setPlayState();
}

function setStatus(text) { $('audio-status').textContent = text; }

function setPlayState() {
  const b = $('play-btn');
  b.disabled = prep.state === 'resolving';
  b.textContent = { idle: '▶ Play preview', resolving: 'Loading…', ready: '▶ Play preview', failed: '↻ Retry' }[prep.state];
  if (prep.state === 'failed') setStatus('Preview unavailable (offline?). Tap Retry.');
  else if (prep.state === 'ready') setStatus('');
}

$('play-btn').addEventListener('click', () => {
  if (prep.state === 'failed') { prepare(game.current); return; }
  if (prep.state !== 'ready') return;
  if (audio.getAttribute('src') !== prep.url) audio.src = prep.url;
  audio.currentTime = 0;
  const p = audio.play(); // synchronous inside the click handler
  if (p) {
    p.then(() => dlog(`play() ok ${prep.id}`)).catch((e) => {
      dlog(`play() rejected ${prep.id}: ${e.name}: ${e.message}`);
      setStatus(`Couldn't play (${e.name}). Tap again.`);
    });
  }
});
audio.addEventListener('playing', () => setStatus('Playing…'));
audio.addEventListener('ended', () => setStatus('Done. Tap to replay.'));
audio.addEventListener('error', () => {
  const code = audio.error ? audio.error.code : '?';
  dlog(`audio error code=${code} id=${prep.id} src=${audio.getAttribute('src')}`);
  if (prep.state === 'ready') setStatus('Preview failed to load (offline?). Tap to retry.');
});

// ---------- game flow ----------
let songs = [];
let game = null;

const isGroup = () => game.players.length > 1;

function show(name) {
  for (const id of ['setup', 'play', 'end']) $(id).hidden = id !== name;
  document.body.classList.toggle('wide', name === 'play');
}

// Language is always Hebrew + English and the year span is the whole catalog.
function readSettings() {
  const years = songs.map((x) => x.year);
  return {
    players: $('mode').value === 'solo' ? 1 : Number($('players').value),
    yearFrom: Math.min(...years),
    yearTo: Math.max(...years),
    languages: ['he', 'en'],
    targetCards: Number($('target').value),
  };
}

// Play history (per device): songs drawn recently are deprioritised in later games. See weightedOrder().
const HISTORY_KEY = 'timeline-history-v1';
let history = { n: 0, s: {} };
function loadHistory() {
  try {
    const h = JSON.parse(localStorage.getItem(HISTORY_KEY));
    if (h && Number.isInteger(h.n) && h.s && typeof h.s === 'object') return h;
  } catch { /* storage unavailable or corrupt: behave like a fresh install */ }
  return { n: 0, s: {} };
}
function markPlayed(...ids) {
  history = recordPlayed(history, ids, history.n);
  try { localStorage.setItem(HISTORY_KEY, JSON.stringify(history)); } catch { /* ignore */ }
}

$('mode').addEventListener('change', () => { $('players-row').hidden = $('mode').value === 'solo'; });

$('setup-form').addEventListener('submit', (e) => {
  e.preventDefault();
  $('setup-error').textContent = '';
  try {
    history = loadHistory();
    game = createGame(songs, readSettings(), Math.random, history);
    history = { ...history, n: history.n + 1 };
    markPlayed(...game.players.map((p) => p.timeline[0].id), game.current.id);
  } catch (err) {
    $('setup-error').textContent = err.message;
    return;
  }
  dlog(`game start ${JSON.stringify(game.settings)}`);
  show('play');
  render();
  prepare(game.current);
});

// ---- rendering ----
const PALETTE = 8; // border/avatar colors: .k0 .. .k7 in style.css
const cardsLabel = (p) =>
  `${p.timeline.length}/${game.settings.targetCards}${isGroup() ? ` · 🃏 ${p.challenges}` : ''}`;

function timelineCard(s, k, highlight) {
  const li = el('li', `tl-card k${k % PALETTE}${highlight ? ' new' : ''}`);
  const title = el('div', 'tl-title', s.title);
  const artist = el('div', 'tl-artist', s.artist);
  title.dir = artist.dir = 'auto';
  li.append(el('div', 'tl-year', String(s.year)), title, artist);
  return li;
}

// Who may click slots in the active timeline right now?
function slotMode() {
  if (game.status !== 'playing' || game.phase === 'revealed') return null;
  if (awaitingChallengerSlot(game)) return 'challenger';
  return game.pending.challenger !== null ? null : 'active';
}

function marker(role, text, verdict) {
  const cls = verdict === true ? ' good' : verdict === false ? ' bad' : '';
  const sym = verdict === true ? '✓' : verdict === false ? '✗' : '◆';
  const li = el('li', `marker ${role}${cls}`);
  li.setAttribute('aria-label', text);
  li.append(el('span', 'sym', sym), el('span', 'cap', text));
  return li;
}

function slotItem(i, mode) {
  const tl = activePlayer(game).timeline;
  const label = mode === 'challenger' ? 'Challenge here' : game.pending.slot === null ? 'Place here' : 'Move here';
  const b = el('button', 'slot', '+');
  b.type = 'button';
  b.title = label;
  const where = i === 0 ? 'before the first card' : i === tl.length ? 'after the last card' : `between ${tl[i - 1].year} and ${tl[i].year}`;
  b.setAttribute('aria-label', `${label}: ${where}`);
  b.addEventListener('click', () => onSlot(i, mode));
  const li = el('li');
  li.append(b);
  return li;
}

function renderActive(highlightId) {
  const a = activePlayer(game);
  const head = $('active-head');
  head.replaceChildren(
    el('span', 'player-title', isGroup() ? `${a.name}'s timeline` : 'Your timeline'),
    el('span', 'badge', `${a.timeline.length} / ${game.settings.targetCards}`),
  );
  if (isGroup()) head.append(el('span', 'badge', `🃏 ${a.challenges}`));
  const root = $('timeline');
  root.replaceChildren();
  const tl = a.timeline; // after a reveal it already contains the awarded card
  $('arrow-from').textContent = tl.length ? String(tl[0].year) : '';
  $('arrow-to').textContent = tl.length ? String(tl[tl.length - 1].year) : '';
  const { slot, challenger, challengerSlot } = game.pending;
  const out = game.outcome;
  const mode = slotMode();
  // Markers refer to gaps of the timeline as it was when placing; an inserted card shifts later gaps by one.
  const bShift = out && out.aCorrect && challengerSlot !== null && challengerSlot > slot ? 1 : 0;
  for (let i = 0; i <= tl.length; i++) {
    if (slot === i) root.append(marker('role-a', `${a.name}'s guess`, out ? out.aCorrect : null));
    if (challengerSlot !== null && challengerSlot + bShift === i) {
      root.append(marker('role-b', `${game.players[challenger].name}'s challenge`, out ? out.challengerCorrect : null));
    }
    if (mode && i !== slot) root.append(slotItem(i, mode));
    if (i < tl.length) root.append(timelineCard(tl[i], i, tl[i].id === highlightId));
  }
  // Keep the interesting spot in view when the timeline overflows horizontally.
  const focus = root.querySelector('.marker, .tl-card.new');
  if (focus) focus.scrollIntoView({ inline: 'center', block: 'nearest' });
  else root.scrollLeft = 0;
}

// Corner status of the non-active players: card count + challenge chips (no timelines).
function renderOthers() {
  const root = $('others');
  root.replaceChildren();
  game.players.forEach((p, i) => {
    if (i === game.turn) return;
    const box = el('div', 'pl');
    box.setAttribute('role', 'group');
    box.setAttribute('aria-label', `${p.name}: ${cardsLabel(p)}`);
    const av = el('div', `av k${i % PALETTE}`, String(i + 1));
    av.append(el('small', '', String(p.timeline.length)), el('em', '', `🃏${p.challenges}`));
    const names = el('div', 'pl-name');
    names.append(el('b', '', p.name), el('span', 'muted small', `${p.timeline.length}/${game.settings.targetCards} cards`));
    box.append(av, names);
    root.append(box);
  });
  root.hidden = !isGroup();
}

function renderChallengeBox() {
  const box = $('challenge-box');
  const btns = $('challenge-btns');
  btns.replaceChildren();
  const { challenger } = game.pending;
  if (!isGroup() || game.phase !== 'placed') { box.hidden = true; return; }
  if (challenger !== null) {
    box.hidden = false;
    $('challenge-text').textContent = `${game.players[challenger].name} challenged (challenge card spent until the reveal).`;
    return;
  }
  const eligible = eligibleChallengers(game);
  box.hidden = eligible.length === 0;
  $('challenge-text').textContent = 'A player holding a challenge card may challenge this placement:';
  for (const idx of eligible) {
    const p = game.players[idx];
    const b = el('button', '', `Challenge: ${p.name} (🃏 ${p.challenges})`);
    b.type = 'button';
    b.addEventListener('click', () => act(() => challenge(game, idx), `challenge by ${p.name}`));
    btns.append(b);
  }
}

function renderReveal() {
  const o = game.outcome;
  const players = game.players;
  const a = players[o.player];
  const group = isGroup();
  $('reveal').className = `card reveal ${o.aCorrect ? 'good' : 'bad'}`;
  $('reveal-result').textContent = `${group ? `${a.name}: ` : ''}${o.aCorrect ? '✓ Correct' : '✗ Wrong'}`;
  const rs = $('reveal-song');
  rs.replaceChildren(el('b', '', o.song.title), el('span', 'muted', o.song.artist)); // separate lines: mixed RTL/LTR safe
  rs.firstChild.dir = rs.lastChild.dir = 'auto';
  $('reveal-year').textContent = String(o.song.year);

  const notes = $('reveal-notes');
  notes.replaceChildren();
  const add = (t) => notes.append(el('li', '', t));
  if (o.awardedTo === o.player) add(group ? `${a.name} keeps the card.` : 'Card added to your timeline.');
  else if (o.awardedTo !== null) add(`${players[o.awardedTo].name} wins the card.`);
  else add('Card discarded.');
  if (o.challenger !== null) {
    const b = players[o.challenger].name;
    add(`${b}'s challenge: ${o.challengerCorrect ? '✓ right' : '✗ wrong'}.`);
    add(o.challengeReturned ? `${b} gets the challenge card back.`
      : o.challengeLost ? `${b} loses the challenge card.` : `${b}'s challenge card is used up.`);
  }
  if (game.finalRound && group) {
    const at = players.filter((p) => p.timeline.length >= game.settings.targetCards).map((p) => p.name).join(' & ');
    add(game.tiebreak
      ? `Tie-break: ${game.tiebreak.players.map((i) => players[i].name).join(' & ')} play on until only one of them wins a card in a round.`
      : `${at} reached ${game.settings.targetCards} cards. Final round: everyone plays the same number of turns; if several players reach the target, a tie-break follows.`);
  }
  if (group && game.claimed) add(`${a.name} claimed a challenge card (+1 🃏).`);

  $('claim-btn').hidden = !group || game.status !== 'playing' || game.claimed;

  const done = endsAfterThisTurn(game);
  $('next-btn').textContent = done ? 'See results'
    : group ? `Pass to ${players[nextPlayerIndex(game)].name}` : 'Next song';
}

function renderPanel() {
  const revealed = game.phase === 'revealed';
  const group = isGroup();
  $('mystery').hidden = revealed;
  $('submit-btn').hidden = revealed;
  $('hint').hidden = revealed;
  $('reveal').hidden = !revealed;
  $('next-btn').hidden = !revealed;
  if (!revealed) $('claim-btn').hidden = true;
  if (revealed) {
    $('challenge-box').hidden = true;
    renderReveal();
    return;
  }
  const { slot, challenger } = game.pending;
  const waiting = awaitingChallengerSlot(game);
  const a = activePlayer(game);
  $('submit-btn').disabled = slot === null || waiting;
  let hint;
  if (slot === null) hint = 'Play the preview, then click where the song belongs in the timeline.';
  else if (waiting) hint = `${game.players[challenger].name}: click a slot in ${a.name}'s timeline.`;
  else if (challenger !== null) hint = 'Both placements are set. Press Reveal answer.';
  else hint = group ? 'Placed. Another player may challenge now, or press Reveal answer.'
    : 'Placed (you can still move it). Press Reveal answer.';
  $('hint').textContent = hint;
  renderChallengeBox();
}

function render() {
  const o = game.outcome;
  const a = activePlayer(game);
  $('turn-name').textContent = isGroup() ? `${a.name}: ${game.phase === 'revealed' ? 'result' : 'your turn'}` : 'Solo game';
  renderOthers();
  renderActive(o && o.awardedTo === game.turn ? o.song.id : null);
  renderPanel();
}

// Run a game action, log it, and re-render. Logic errors are shown in the log, not thrown at the user.
function act(fn, what) {
  try {
    fn();
    dlog(what);
  } catch (e) {
    dlog(`${what} FAILED: ${e.message}`);
  }
  render();
}

function onSlot(i, mode) {
  if (mode === 'challenger') act(() => challengeSlot(game, i), `challenger slot ${i}`);
  else act(() => placeCard(game, i), `placed at slot ${i}`);
}

$('submit-btn').addEventListener('click', () => {
  audio.pause();
  act(() => {
    const o = reveal(game);
    dlog(`reveal ${o.song.id}: A ${o.aCorrect ? 'right' : 'wrong'}` +
      (o.challenger !== null ? `, challenger ${o.challengerCorrect ? 'right' : 'wrong'}` : '') +
      `, awardedTo=${o.awardedTo}`);
  }, 'submit');
});

$('claim-btn').addEventListener('click', () => act(() => claimChallengeCard(game), 'claim challenge card'));

$('next-btn').addEventListener('click', () => {
  try {
    nextTurn(game);
  } catch (e) {
    dlog(`next FAILED: ${e.message}`);
    return;
  }
  if (game.status === 'playing') markPlayed(game.current.id);
  if (game.status !== 'playing') { showEnd(); return; }
  render();
  prepare(game.current);
});

function showEnd() {
  const g = game;
  const names = g.winners.map((i) => g.players[i].name).join(' & ');
  $('end-title').textContent = g.status === 'won'
    ? `${names} ${g.winners.length > 1 ? 'win' : 'wins'}!`
    : g.players.length === 1 ? 'Out of songs' : `Out of songs: ${names} lead`;
  const ul = $('end-stats');
  ul.replaceChildren();
  for (const p of g.players) {
    ul.append(el('li', '', `${p.name}: ${p.timeline.length} cards, ${p.correct}/${p.attempts} correct` +
      (g.players.length > 1 ? `, 🃏 ${p.challenges}` : '')));
  }
  show('end');
}

$('again').addEventListener('click', () => { audio.pause(); show('setup'); });
$('quit').addEventListener('click', () => { audio.pause(); show('setup'); });

// Tap either end of the time arrow to jump to the oldest / newest card.
$('arrow-from').addEventListener('click', () => $('timeline').scrollTo({ left: 0, behavior: 'smooth' }));
$('arrow-to').addEventListener('click', () => {
  const t = $('timeline');
  t.scrollTo({ left: t.scrollWidth, behavior: 'smooth' });
});

// ---------- boot ----------
async function boot() {
  try {
    const r = await fetch('songs.json');
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    songs = await r.json();
    if (!Array.isArray(songs) || !songs.every((s) => s && typeof s.id === 'string' && Number.isInteger(s.year))) {
      throw new Error('songs.json malformed');
    }
    $('start').disabled = false;
    dlog(`catalog loaded: ${songs.length} songs`);
  } catch (e) {
    $('setup-error').textContent = `Could not load songs: ${e.message}`;
    dlog(`catalog FAIL: ${e.message}`);
  }
  if ('serviceWorker' in navigator && !location.search.includes('nosw')) {
    try {
      const reg = await navigator.serviceWorker.register('sw.js');
      dlog(`sw registered, scope=${reg.scope}`);
    } catch (e) {
      dlog(`sw register FAIL: ${e.message}`);
    }
  }
}
boot();
