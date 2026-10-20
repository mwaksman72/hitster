import {
  DEFAULTS, activePlayer, awaitingChallengerSlot, challenge, challengeSlot, claimChallengeCard,
  createGame, eligibleChallengers, nextTurn, placeCard, reveal,
} from './game.js';

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};
const audio = $('audio');

// ---------- diagnostics ----------
const logLines = [];
function dlog(msg) {
  logLines.push(`${new Date().toISOString().slice(11, 23)} ${msg}`);
  if (logLines.length > 300) logLines.shift();
  $('diag-log').textContent = logLines.join('\n');
  console.log(msg);
}
function envInfo() {
  const standalone = navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;
  const sw = 'serviceWorker' in navigator ? (navigator.serviceWorker.controller ? 'controlled' : 'not controlled') : 'unsupported';
  $('env').textContent = `standalone=${standalone} sw=${sw} online=${navigator.onLine}`;
  return $('env').textContent;
}

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
  const mode = $('resolve-mode').value;
  if (mode !== 'stored' && song.itunesTrackId) {
    const t0 = performance.now();
    try {
      const url = await lookup(song);
      if (!allowedPreview(url)) throw new Error('unexpected preview host');
      dlog(`lookup ok ${song.id} ${Math.round(performance.now() - t0)}ms ` +
        (url === song.previewUrl ? '(same as stored)' : '(DIFFERS from stored)'));
      return url;
    } catch (e) {
      dlog(`lookup FAIL ${song.id}: ${e.name}: ${e.message}`);
      if (mode === 'lookup') return null;
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
let peekIdx = null; // narrow screens: index of the other player whose timeline is shown, or null

const isGroup = () => game.players.length > 1;

function show(name) {
  for (const id of ['setup', 'play', 'end']) $(id).hidden = id !== name;
  document.body.classList.toggle('wide', name === 'play');
}

function readSettings() {
  const lang = $('lang').value;
  return {
    players: $('mode').value === 'solo' ? 1 : Number($('players').value),
    yearFrom: Number($('year-from').value),
    yearTo: Number($('year-to').value),
    languages: lang === 'both' ? ['he', 'en'] : [lang],
    targetCards: Number($('target').value),
  };
}

$('mode').addEventListener('change', () => { $('players-row').hidden = $('mode').value === 'solo'; });

$('setup-form').addEventListener('submit', (e) => {
  e.preventDefault();
  $('setup-error').textContent = '';
  try {
    game = createGame(songs, readSettings());
  } catch (err) {
    $('setup-error').textContent = err.message;
    return;
  }
  dlog(`game start ${JSON.stringify(game.settings)}`);
  peekIdx = null;
  show('play');
  render();
  prepare(game.current);
});

// ---- rendering ----
const cardsLabel = (p) =>
  `${p.timeline.length}/${game.settings.targetCards}${isGroup() ? ` · 🃏 ${p.challenges}` : ''}`;

function renderScore() {
  const ul = $('score');
  ul.replaceChildren();
  game.players.forEach((p, i) => {
    const text = `${p.name}: ${cardsLabel(p)}`;
    const li = el('li', i === game.turn ? 'current' : '');
    if (isGroup() && i !== game.turn) {
      // Tap to peek at this player's timeline (narrow screens; the desktop layout always shows them).
      li.classList.add('chip');
      const b = el('button', '', text);
      b.type = 'button';
      b.setAttribute('aria-expanded', String(peekIdx === i));
      b.setAttribute('aria-label', `${text}. Show ${p.name}'s timeline`);
      b.addEventListener('click', () => { peekIdx = peekIdx === i ? null : i; render(); });
      li.append(b);
    } else {
      li.classList.add('chip');
      li.append(el('span', '', text));
    }
    ul.append(li);
  });
}

function timelineCard(s, highlight) {
  const li = el('li', `tl-card${highlight ? ' new' : ''}`);
  const text = el('div');
  const title = el('div', 'tl-title', s.title);
  const artist = el('div', 'tl-artist', s.artist);
  title.dir = artist.dir = 'auto';
  text.append(title, artist);
  li.append(el('div', 'tl-year', String(s.year)), text);
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
  return el('li', `marker ${role}${cls}`, `${sym} ${text}`);
}

function slotItem(i, mode) {
  const tl = activePlayer(game).timeline;
  const label = mode === 'challenger' ? 'Challenge here' : game.pending.slot === null ? 'Place here' : 'Move here';
  const b = el('button', 'slot', label);
  b.type = 'button';
  const where = i === 0 ? 'before the first card' : i === tl.length ? 'after the last card' : `between ${tl[i - 1].year} and ${tl[i].year}`;
  b.setAttribute('aria-label', `${label}: ${where}`);
  b.addEventListener('click', () => onSlot(i, mode));
  const li = el('li');
  li.append(b);
  return li;
}

function renderActive(highlightId) {
  const a = activePlayer(game);
  $('active-head').replaceChildren(
    el('span', '', isGroup() ? `${a.name}'s timeline` : 'Your timeline'),
    el('span', 'badge', cardsLabel(a)),
  );
  const root = $('timeline');
  root.replaceChildren();
  const tl = a.timeline; // after a reveal it already contains the awarded card
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
    if (i < tl.length) root.append(timelineCard(tl[i], tl[i].id === highlightId));
  }
}

function renderOthers(awardedTo, songId) {
  const root = $('others');
  root.replaceChildren();
  game.players.forEach((p, i) => {
    if (i === game.turn) return;
    const box = el('div', `mini${i === peekIdx ? ' peek' : ''}`);
    box.append(el('div', 'player-head'));
    box.firstChild.append(el('span', '', p.name), el('span', 'badge', cardsLabel(p)));
    const ol = el('ol', 'timeline');
    for (const s of p.timeline) ol.append(timelineCard(s, i === awardedTo && s.id === songId));
    box.append(ol);
    root.append(box);
  });
  root.hidden = !isGroup();
  root.classList.toggle('open', peekIdx !== null);
  $('board').classList.toggle('solo', !isGroup());
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
  $('reveal-song').textContent = `${o.song.title}, ${o.song.artist}`;
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
  if (group && game.claimed) add(`${a.name} claimed a challenge card (+1 🃏).`);

  $('claim-btn').hidden = !group || game.status !== 'playing' || game.claimed;

  const done = game.status !== 'playing' || game.pool.length === 0;
  $('next-btn').textContent = done ? 'See results'
    : group ? `Pass to ${players[(game.turn + 1) % players.length].name}` : 'Next song';
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
  if (peekIdx === game.turn) peekIdx = null;
  const o = game.outcome;
  const a = activePlayer(game);
  $('turn-name').textContent = isGroup() ? `${a.name}: ${game.phase === 'revealed' ? 'result' : 'your turn'}` : 'Solo game';
  renderScore();
  renderOthers(o ? o.awardedTo : null, o ? o.song.id : null);
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
    // Narrow screens: show where the card went if another player won it.
    peekIdx = o.awardedTo !== null && o.awardedTo !== o.player ? o.awardedTo : null;
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
  if (game.status !== 'playing') { showEnd(); return; }
  peekIdx = null;
  render();
  prepare(game.current);
});

function showEnd() {
  const g = game;
  const names = g.winners.map((i) => g.players[i].name).join(' & ');
  $('end-title').textContent = g.status === 'won'
    ? `${names} wins!`
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

// ---------- diagnostics actions ----------
$('check-all').addEventListener('click', async () => {
  dlog(`--- lookup check (${envInfo()}) ---`);
  for (const s of songs) {
    const t0 = performance.now();
    try {
      const url = await lookup(s);
      dlog(`${s.id}: ok ${Math.round(performance.now() - t0)}ms ${url === s.previewUrl ? 'same' : 'DIFFERS'} ${allowedPreview(url) ? '' : 'BAD-HOST'}`);
    } catch (e) {
      dlog(`${s.id}: FAIL ${e.name}: ${e.message}`);
    }
  }
  dlog('--- done ---');
});
$('copy-log').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(logLines.join('\n'));
    dlog('log copied');
  } catch (e) {
    dlog(`copy failed: ${e.message} (select the log text manually)`);
  }
});

// ---------- boot ----------
async function boot() {
  $('year-to').value = DEFAULTS.yearTo;
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
  envInfo();
  addEventListener('online', () => { dlog('online'); envInfo(); });
  addEventListener('offline', () => { dlog('offline'); envInfo(); });
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
