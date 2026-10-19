import { DEFAULTS, createGame, placeCard } from './game.js';

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

async function lookup(song) {
  const country = song.lang === 'he' ? 'IL' : 'US';
  const r = await fetchTimeout(
    `https://itunes.apple.com/lookup?id=${encodeURIComponent(song.itunesTrackId)}&country=${country}`, 5000);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const url = (await r.json()).results?.[0]?.previewUrl;
  if (!url) throw new Error('no previewUrl in response');
  return url;
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
let reveal = null; // result of the last placement, shown until "Next"

function show(name) {
  for (const id of ['setup', 'play', 'end']) $(id).hidden = id !== name;
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
  reveal = null;
  dlog(`game start ${JSON.stringify(game.settings)}`);
  show('play');
  render();
  prepare(game.current);
});

function renderScore(activeIdx) {
  const ul = $('score');
  ul.replaceChildren();
  game.players.forEach((p, i) => {
    ul.append(el('li', i === activeIdx ? 'current' : '', `${p.name}: ${p.timeline.length}/${game.settings.targetCards}`));
  });
}

function renderTimeline(player, interactive, highlightId) {
  const root = $('timeline');
  root.replaceChildren();
  const tl = player.timeline;
  for (let i = 0; i <= tl.length; i++) {
    if (interactive) {
      const li = el('li');
      const b = el('button', 'slot', 'Place here');
      b.type = 'button';
      const where = i === 0 ? 'before the first card' : i === tl.length ? 'after the last card' : `between ${tl[i - 1].year} and ${tl[i].year}`;
      b.setAttribute('aria-label', `Place song ${where}`);
      b.addEventListener('click', () => onPlace(i));
      li.append(b);
      root.append(li);
    }
    if (i < tl.length) {
      const s = tl[i];
      const li = el('li', `tl-card${s.id === highlightId ? ' new' : ''}`);
      const text = el('div');
      const title = el('div', 'tl-title', s.title);
      const artist = el('div', 'tl-artist', s.artist);
      title.dir = artist.dir = 'auto';
      text.append(title, artist);
      li.append(el('div', 'tl-year', String(s.year)), text);
      root.append(li);
    }
  }
}

function render() {
  const idx = reveal ? reveal.player : game.turn;
  const p = game.players[idx];
  $('turn-name').textContent = reveal ? p.name : `${p.name}: your turn`;
  renderScore(idx);
  $('mystery').hidden = !!reveal;
  $('reveal').hidden = !reveal;
  if (reveal) {
    const r = $('reveal');
    r.className = `card reveal ${reveal.correct ? 'good' : 'bad'}`;
    $('reveal-result').textContent = reveal.correct ? '✓ Correct' : '✗ Wrong';
    $('reveal-song').textContent = `${reveal.song.title}, ${reveal.song.artist}`;
    $('reveal-year').textContent = String(reveal.song.year);
    $('reveal-note').textContent = reveal.correct ? 'Card added to your timeline.' : 'Card discarded.';
    const next = game.status !== 'playing' ? 'See results' : game.players.length > 1 ? `Pass to ${game.players[game.turn].name}` : 'Next song';
    $('next-btn').textContent = next;
  }
  renderTimeline(p, !reveal, reveal && reveal.correct ? reveal.song.id : null);
}

function onPlace(i) {
  if (reveal || !game || game.status !== 'playing') return;
  audio.pause();
  reveal = placeCard(game, i);
  dlog(`placed ${reveal.song.id} at ${i}: ${reveal.correct ? 'correct' : 'wrong'}`);
  render();
}

$('next-btn').addEventListener('click', () => {
  reveal = null;
  if (game.status !== 'playing') { showEnd(); return; }
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
  for (const p of g.players) ul.append(el('li', '', `${p.name}: ${p.timeline.length} cards, ${p.correct}/${p.attempts} correct`));
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
