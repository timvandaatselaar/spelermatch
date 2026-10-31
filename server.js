// Spelermatch: iedereen kiest tegelijk een voetballer, daarna wordt alles tegelijk onthuld.
// Geen dependencies: alleen Node 18+. Foto's zoekt de browser zelf op Wikipedia. Start met `node server.js`.
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const COUNTDOWN_MS = 3000;
const OFFLINE_GRACE_MS = 60_000;
const LAST_CALL_MS = 60_000;
const SCORES_FILE = path.join(process.env.DATA_DIR || path.join(__dirname, 'data'), 'highscores.json');
const GIST_NAME = 'spelermatch-highscores.json';
const INDEX_HTML = fs.readFileSync(path.join(__dirname, 'public', 'index.html'));

// --- Spelstatus ---------------------------------------------------------------

const players = new Map(); // key -> { name, conns: Set<res>, lastSeen }
let game = newGame();

function newGame() {
  return { round: 1, phase: 'collect', picks: {}, revealAt: null, history: [], skipped: new Set(), lastCall: null };
}

const keyOf = (name) => String(name || '').trim().toLowerCase();
const onlinePlayers = () => [...players.entries()].filter(([, p]) => p.conns.size > 0);

// Wie de laatste minuut liet verstrijken, telt deze ronde niet meer mee.
function allSubmitted() {
  const online = onlinePlayers();
  return online.some(([k]) => game.picks[k]) && online.every(([k]) => game.picks[k] || game.skipped.has(k));
}

// --- Laatste minuut -----------------------------------------------------------
// Moet er nog maar één speler kiezen, dan krijgt die 60 seconden. Daarna wordt die overgeslagen.

let lastCallTimer = null;

function updateLastCall() {
  const online = onlinePlayers();
  const missing = online.filter(([k]) => !game.picks[k] && !game.skipped.has(k)).map(([k]) => k);
  const due = game.phase === 'collect' && online.length >= 2 && missing.length === 1;
  if (!due) {
    clearTimeout(lastCallTimer);
    game.lastCall = null;
    return;
  }
  if (game.lastCall?.key === missing[0]) return;
  clearTimeout(lastCallTimer);
  const lastCall = { key: missing[0], endsAt: Date.now() + LAST_CALL_MS };
  game.lastCall = lastCall;
  lastCallTimer = setTimeout(() => {
    if (game.lastCall !== lastCall || game.picks[lastCall.key]) return;
    game.skipped.add(lastCall.key);
    game.lastCall = null;
    broadcast();
  }, LAST_CALL_MS);
}

// --- Highscores ---------------------------------------------------------------
// Iedereen die hetzelfde antwoord heeft als minstens één ander, krijgt een punt.
// Bewaard in een bestand en, als GITHUB_TOKEN is ingesteld, in een privé-gist: gratis hosting wist bestanden bij elke deploy.

let scores = {}; // key -> { name, points }

function awardPoints(picks) {
  const byPick = new Map();
  for (const p of picks) byPick.set(p.id, [...(byPick.get(p.id) || []), p.player]);
  let changed = false;
  for (const names of byPick.values()) {
    if (names.length < 2) continue;
    for (const name of names) {
      const k = keyOf(name);
      scores[k] = { name, points: (scores[k]?.points || 0) + 1 };
      changed = true;
    }
  }
  if (changed) saveScores();
}

const topScores = () => Object.values(scores).sort((a, b) => b.points - a.points || a.name.localeCompare(b.name)).slice(0, 50);

const gist = { id: null };
async function github(pathname, options = {}) {
  const res = await fetch('https://api.github.com' + pathname, {
    ...options,
    headers: { Authorization: `Bearer ${process.env.GITHUB_TOKEN}`, Accept: 'application/vnd.github+json', 'User-Agent': 'spelermatch', ...options.headers },
  });
  if (!res.ok) throw new Error(`GitHub ${res.status}`);
  return res.json();
}

async function loadScores() {
  try { scores = JSON.parse(fs.readFileSync(SCORES_FILE, 'utf8')); } catch {}
  if (!process.env.GITHUB_TOKEN) return;
  try {
    const list = await github('/gists?per_page=100');
    const found = list.find((g) => g.files[GIST_NAME]);
    if (found) {
      gist.id = found.id;
      const full = await github('/gists/' + found.id);
      scores = { ...scores, ...JSON.parse(full.files[GIST_NAME].content || '{}') };
    } else {
      const created = await github('/gists', { method: 'POST', body: JSON.stringify({ description: 'Spelermatch highscores', public: false, files: { [GIST_NAME]: { content: JSON.stringify(scores) } } }) });
      gist.id = created.id;
    }
    console.log('Highscores geladen uit gist ' + gist.id);
  } catch (err) {
    console.error('Highscores uit gist laden mislukt:', err.message);
  }
}

let saveTimer = null;
function saveScores() {
  try {
    fs.mkdirSync(path.dirname(SCORES_FILE), { recursive: true });
    fs.writeFileSync(SCORES_FILE, JSON.stringify(scores));
  } catch (err) {
    console.error('Highscores opslaan mislukt:', err.message);
  }
  if (!gist.id) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    github('/gists/' + gist.id, { method: 'PATCH', body: JSON.stringify({ files: { [GIST_NAME]: { content: JSON.stringify(scores) } } }) })
      .catch((err) => console.error('Highscores naar gist schrijven mislukt:', err.message));
  }, 2000);
}

function isMatch(picks) {
  const ids = picks.map((p) => p.id);
  return ids.length >= 2 && ids.every((id) => id === ids[0]);
}

function revealedPicks() {
  return Object.entries(game.picks).map(([k, pick]) => ({
    player: players.get(k)?.name || k,
    ...pick,
  }));
}

function stateFor(viewerKey) {
  const online = new Set(onlinePlayers().map(([k]) => k));
  return {
    round: game.round,
    phase: game.phase,
    revealInMs: game.revealAt ? Math.max(0, game.revealAt - Date.now()) : null,
    allSubmitted: allSubmitted(),
    lastCall: game.lastCall ? { name: players.get(game.lastCall.key)?.name || game.lastCall.key, you: game.lastCall.key === viewerKey, inMs: Math.max(0, game.lastCall.endsAt - Date.now()) } : null,
    skipped: [...game.skipped].map((k) => players.get(k)?.name || k),
    scores: topScores(),
    players: [...players.entries()]
      .filter(([k]) => online.has(k) || game.picks[k])
      .map(([k, p]) => ({ name: p.name, online: online.has(k), submitted: !!game.picks[k], you: k === viewerKey })),
    myPick: game.picks[viewerKey] || null,
    reveal: game.phase === 'reveal' ? revealedPicks() : null,
    match: game.phase === 'reveal' ? isMatch(revealedPicks()) : false,
    history: game.history,
  };
}

function broadcast() {
  updateLastCall();
  for (const [key, p] of players) {
    const data = `data: ${JSON.stringify(stateFor(key))}\n\n`;
    for (const res of p.conns) res.write(data);
  }
}

function startCountdown() {
  game.phase = 'countdown';
  game.revealAt = Date.now() + COUNTDOWN_MS;
  setTimeout(() => {
    if (game.phase !== 'countdown') return;
    game.phase = 'reveal';
    game.revealAt = null;
    const picks = revealedPicks();
    game.history.push({ round: game.round, picks, match: isMatch(picks) });
    awardPoints(picks);
    broadcast();
  }, COUNTDOWN_MS);
}

// Spelers die langer dan een minuut weg zijn verdwijnen uit de lijst.
setInterval(() => {
  let changed = false;
  for (const [k, p] of players) {
    if (p.conns.size === 0 && Date.now() - p.lastSeen > OFFLINE_GRACE_MS) {
      players.delete(k);
      if (game.phase === 'collect') delete game.picks[k];
      changed = true;
    }
  }
  if (changed) broadcast();
}, 10_000);

// --- HTTP ---------------------------------------------------------------------

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 10_000) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(data || '{}')); } catch { resolve({}); } });
  });
}

// Alleen afbeeldingen van Wikimedia; alles anders wordt genegeerd.
const safeImage = (url) => (typeof url === 'string' && url.length < 500 && /^https:\/\/[a-z.]+\.wikimedia\.org\//.test(url) ? url : null);

const samePlayer = (a, b) => a.id === b.id || keyOf(a.title) === keyOf(b.title);

function cleanPick(pick) {
  if (!pick || typeof pick !== 'object') return null;
  const title = String(pick.title || '').trim().slice(0, 80);
  if (!title) return null;
  const image = safeImage(pick.image);
  const country = pick.country && typeof pick.country === 'object'
    ? { name: String(pick.country.name || '').slice(0, 60), flag: safeImage(pick.country.flag) }
    : null;
  const clubs = Array.isArray(pick.clubs)
    ? pick.clubs.slice(0, 8).map((c) => ({ name: String(c?.name || '').slice(0, 60), logo: safeImage(c?.logo) })).filter((c) => c.name)
    : [];
  return {
    country,
    clubs,
    id: pick.id ? Number(pick.id) || keyOf(title) : keyOf(title),
    title,
    description: String(pick.description || '').slice(0, 120),
    image,
  };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === 'GET' && url.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(INDEX_HTML);
  }

  if (req.method === 'GET' && url.pathname === '/events') {
    const name = String(url.searchParams.get('name') || '').trim().slice(0, 24);
    const key = keyOf(name);
    if (!key) return sendJson(res, 400, { error: 'Vul een naam in.' });
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    if (!players.has(key)) players.set(key, { name, conns: new Set(), lastSeen: Date.now() });
    const player = players.get(key);
    player.conns.add(res);
    const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
    req.on('close', () => {
      clearInterval(ping);
      player.conns.delete(res);
      player.lastSeen = Date.now();
      broadcast();
    });
    return broadcast();
  }

  if (req.method === 'POST' && url.pathname.startsWith('/api/')) {
    const body = await readBody(req);
    const key = keyOf(body.name);
    const action = url.pathname.slice(5);

    if (action === 'pick') {
      if (!players.has(key)) return sendJson(res, 400, { error: 'Log opnieuw in.' });
      if (game.phase !== 'collect') return sendJson(res, 409, { error: 'De ronde is al onthuld.' });
      const pick = cleanPick(body.pick);
      if (!pick) return sendJson(res, 400, { error: 'Kies eerst een speler.' });
      // Een speler mag per spel maar één keer genoemd worden (in dezelfde ronde mag het wel: dat is de match).
      const earlier = game.history.find((h) => h.picks.some((p) => samePlayer(p, pick)));
      if (earlier) return sendJson(res, 409, { error: `${pick.title} is al genoemd in ronde ${earlier.round}. Kies een andere speler.` });
      game.picks[key] = pick;
    } else if (action === 'details') {
      // Vlag en clubs komen na het insturen binnen, zodat kiezen direct gaat.
      const extra = cleanPick({ title: 'details', country: body.country, clubs: body.clubs });
      const id = Number(body.id);
      const targets = [game.picks[key], ...(game.history.at(-1)?.picks || []).filter((p) => keyOf(p.player) === key)];
      for (const t of targets) if (t && t.id === id) Object.assign(t, { country: extra.country, clubs: extra.clubs });
    } else if (action === 'unpick') {
      if (game.phase === 'collect') delete game.picks[key];
    } else if (action === 'reveal') {
      if (game.phase === 'collect' && allSubmitted()) startCountdown();
    } else if (action === 'next') {
      // Na een match begint een nieuwe reeks; anders gaat de huidige reeks door.
      if (game.phase === 'reveal' && game.history.at(-1)?.match) {
        game = newGame();
      } else if (game.phase === 'reveal') {
        game.round += 1;
        game.phase = 'collect';
        game.picks = {};
        game.skipped = new Set();
      }
    } else if (action === 'ping') {
      // Houdt gratis hosting (Render) wakker zolang er iemand speelt.
      return sendJson(res, 200, { ok: true });
    } else if (action === 'reset') {
      game = newGame();
    } else {
      return sendJson(res, 404, { error: 'Onbekende actie.' });
    }
    broadcast();
    return sendJson(res, 200, { ok: true });
  }

  sendJson(res, 404, { error: 'Niet gevonden.' });
});

loadScores().finally(() => server.listen(PORT, () => console.log(`Spelermatch draait op http://localhost:${PORT}`)));
