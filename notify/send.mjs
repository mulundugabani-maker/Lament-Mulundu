import admin from 'firebase-admin';
import fs from 'node:fs';

const { OS_APP_ID, OS_API_KEY, FIREBASE_SERVICE_ACCOUNT, SITE, TEST } = process.env;
const MODE = process.argv[2];
const DAY = 864e5;
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(FIREBASE_SERVICE_ACCOUNT)) });
const db = admin.firestore();

const posts = [];
(await db.collection('posts').where('published', '==', true).get()).forEach(d => {
  if (d.id.startsWith('_')) return;
  const p = d.data(); p.id = d.id;
  if (Array.isArray(p.body) && p.body.length) posts.push(p);
});

/* ---- step 1: copy each cover to push/<id>.jpg so the phone can download it ---- */
if (MODE === 'prepare') {
  fs.mkdirSync('push', { recursive: true });
  let n = 0;
  for (const p of posts) {
    const m = /^data:image\/\w+;base64,(.+)$/.exec(p.thumb || '');
    if (!m) continue;
    const buf = Buffer.from(m[1], 'base64'), f = `push/${p.id}.jpg`;
    if (fs.existsSync(f) && fs.readFileSync(f).equals(buf)) continue;
    fs.writeFileSync(f, buf); n++;
  }
  console.log('pictures updated:', n);
  process.exit(0);
}

/* ---- step 2: decide what to send ---- */
const stRef = db.doc('meta/pushstate');
const snap = await stRef.get();
const now = Date.now();
const local = new Date(now + 2 * 3600e3);            // Zambia time (UTC+2)
const hour = local.getUTCHours(), dow = local.getUTCDay(), today = local.toISOString().slice(0, 10);
let st = snap.exists ? snap.data() : null;

const txt = p => {
  let t = String(p.desc || '').replace(/\s+/g, ' ').trim();
  if (!t) for (const b of p.body) { const v = String(typeof b === 'string' ? b : (b && b.t) || '').replace(/[*_#>`]/g, '').replace(/\s+/g, ' ').trim(); if (v.length > 20) { t = v; break } }
  return t.length > 120 ? t.slice(0, 117).replace(/\s+\S*$/, '') + '…' : t;
};
const imgOk = {};
async function img(p) {
  if (!p.thumb) return null;
  const u = `${SITE}/push/${p.id}.jpg`;
  if (!(u in imgOk)) {
    imgOk[u] = false;
    for (let i = 0; i < 24 && !imgOk[u]; i++) {            // wait up to ~6 min for GitHub Pages to publish it
      try { imgOk[u] = (await fetch(u, { method: 'HEAD' })).ok } catch (e) {}
      if (!imgOk[u]) await new Promise(r => setTimeout(r, 15000));
    }
  }
  return imgOk[u] ? `${u}?v=${p.upd || p.ts || 0}` : null;
}
async function push(target, p, heading, body) {
  const im = p ? await img(p) : null;
  const o = { app_id: OS_APP_ID, target_channel: 'push', headings: { en: heading }, contents: { en: body } };
  if (p) o.url = `${SITE}/?p=${p.id}`;
  if (im) { o.big_picture = im; o.chrome_web_image = im }
  Object.assign(o, target);
  const r = await fetch('https://api.onesignal.com/notifications?c=push', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Key ${OS_API_KEY}` }, body: JSON.stringify(o) });
  const j = await r.text();
  console.log(r.status, heading, '->', j.slice(0, 160));
  return r.ok;
}
const everyone = { included_segments: ['Total Subscriptions'] };

if (TEST === 'yes') await push(everyone, posts[posts.length - 1], 'Test alert', 'If you can see this, phone alerts are working.');

/* first ever run: remember what already exists so old pieces are never announced */
if (!st) {
  st = { sent: posts.map(p => p.id), remind: {}, remindDay: '', weeklyAt: 0 };
  await stRef.set(st);
  console.log('First run: saved', st.sent.length, 'existing pieces. No alerts sent.');
  process.exit(0);
}
st.sent = st.sent || []; st.remind = st.remind || {};

/* 1. a new piece was published */
const fresh = posts.filter(p => !st.sent.includes(p.id));
for (const p of fresh.filter(p => now - (p.upd || p.ts || 0) < 3 * DAY).slice(0, 3)) {
  await push(everyone, p, 'New: ' + p.title, txt(p));
}
fresh.forEach(p => st.sent.push(p.id));

/* 2. gentle reminder to finish a piece (once a day, evening) */
if (hour >= 17 && hour < 20 && st.remindDay !== today) {
  const byId = Object.fromEntries(posts.map(p => [p.id, p]));
  let sent = 0;
  for (const d of (await db.collection('users').get()).docs) {
    if (sent >= 100) break;
    const u = d.data(), read = u.read || [], prog = u.prog || {};
    if (now - (u.lastSeen || 0) < 36 * 3600e3) continue;          // they were here recently
    if (now - (st.remind[d.id] || 0) < 4 * DAY) continue;          // not reminded in the last 4 days
    const open = Object.keys(prog).filter(k => byId[k] && !read.includes(k) && prog[k] > .03 && prog[k] < .95);
    if (!open.length) continue;
    const k = open.includes(u.last) ? u.last : open.sort((a, b) => prog[b] - prog[a])[0], p = byId[k];
    const who = (u.name || '').split(' ')[0];
    if (await push({ include_aliases: { external_id: [d.id] } }, p, (who ? who + ', f' : 'F') + 'inish what you started', `You are ${Math.round(prog[k] * 100)}% through “${p.title}”. Pick it up where you left off.`)) { st.remind[d.id] = now; sent++ }
  }
  st.remindDay = today;
}

/* 3. weekly "come read" nudge (Sunday afternoon) */
if (dow === 0 && hour >= 16 && hour < 20 && now - (st.weeklyAt || 0) > 6 * DAY && posts.length) {
  const p = posts.slice().sort((a, b) => (b.ts || 0) - (a.ts || 0))[0];
  if (await push(everyone, p, 'Sunday reading time', `Make a cup of tea and read “${p.title}”. ${txt(p)}`)) st.weeklyAt = now;
}

await stRef.set(st);
