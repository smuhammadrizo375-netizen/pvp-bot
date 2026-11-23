import express from 'express';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@libsql/client';

const E = process.env;
const PORT = E.PORT || 3000, BASE = (E.BASE_URL || '').replace(/\/$/, '');
const db = createClient({ url: E.TURSO_DATABASE_URL, authToken: E.TURSO_AUTH_TOKEN });
const dir = path.dirname(fileURLToPath(import.meta.url));
const K = crypto.createHash('sha256').update(E.ENC_KEY || 'change-me').digest();
const enc = s => { const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', K, iv); const d = Buffer.concat([c.update(s, 'utf8'), c.final()]); return Buffer.concat([iv, c.getAuthTag(), d]).toString('base64'); };
const dec = s => { const b = Buffer.from(s, 'base64'), d = crypto.createDecipheriv('aes-256-gcm', K, b.subarray(0, 12)); d.setAuthTag(b.subarray(12, 28)); return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8'); };
const sec = id => crypto.createHmac('sha256', K).update('wh' + id).digest('hex').slice(0, 32);

await db.batch([
  `CREATE TABLE IF NOT EXISTS bots(id TEXT PRIMARY KEY, token TEXT, username TEXT, owner_id TEXT, active INTEGER DEFAULT 1, created INTEGER)`,
  `CREATE TABLE IF NOT EXISTS users(bot_id TEXT, tg_id TEXT, name TEXT, balance INTEGER DEFAULT 0, ref_by TEXT, created INTEGER, PRIMARY KEY(bot_id,tg_id))`,
  `CREATE TABLE IF NOT EXISTS tx(id INTEGER PRIMARY KEY AUTOINCREMENT, bot_id TEXT, tg_id TEXT, amount INTEGER, type TEXT, note TEXT, ts INTEGER)`,
  `CREATE TABLE IF NOT EXISTS promos(bot_id TEXT, code TEXT, stars INTEGER, max INTEGER, used INTEGER DEFAULT 0, active INTEGER DEFAULT 1, PRIMARY KEY(bot_id,code))`,
  `CREATE TABLE IF NOT EXISTS promo_uses(bot_id TEXT, code TEXT, tg_id TEXT, PRIMARY KEY(bot_id,code,tg_id))`,
  `CREATE TABLE IF NOT EXISTS games(id INTEGER PRIMARY KEY AUTOINCREMENT, bot_id TEXT, bet INTEGER, p1 TEXT, p2 TEXT, r1 INTEGER, r2 INTEGER, winner TEXT, fee INTEGER DEFAULT 0, status TEXT, ts INTEGER)`,
  `CREATE TABLE IF NOT EXISTS settings(bot_id TEXT, k TEXT, v INTEGER, PRIMARY KEY(bot_id,k))`,
  `CREATE INDEX IF NOT EXISTS g_wait ON games(bot_id,status,bet)`
], 'write');

const q = (sql, args = []) => db.execute({ sql, args });
const one = async (sql, args) => (await q(sql, args)).rows[0];
async function txn(fn) { const t = await db.transaction('write'); try { const r = await fn(t); await t.commit(); return r; } catch (e) { await t.rollback(); throw e; } finally { t.close(); } }
async function add(t, b, u, amt, type, note = '') {
  await t.execute({ sql: 'UPDATE users SET balance=balance+? WHERE bot_id=? AND tg_id=?', args: [amt, b, u] });
  await t.execute({ sql: 'INSERT INTO tx(bot_id,tg_id,amount,type,note,ts) VALUES(?,?,?,?,?,?)', args: [b, u, amt, type, note, Date.now()] });
}
async function cfg(b) { const d = { min: 100, fee: 5, ref: 50 }; for (const r of (await q('SELECT k,v FROM settings WHERE bot_id=?', [b])).rows) d[r.k] = Number(r.v); return d; }

async function tg(token, method, body = {}) {
  const r = await fetch(`https://api.telegram.org/bot${token}/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json(); if (!j.ok) throw new Error(j.description); return j.result;
}
const cache = new Map();
async function getBot(id) {
  if (cache.has(id)) return cache.get(id);
  const r = await one('SELECT * FROM bots WHERE id=?', [String(id)]); if (!r) return null;
  const bot = { id: r.id, token: dec(r.token), username: r.username, owner: r.owner_id, active: !!r.active };
  cache.set(id, bot); return bot;
}
async function registerBot(token, owner) {
  const me = await tg(token, 'getMe'), id = String(me.id);
  await q(`INSERT INTO bots(id,token,username,owner_id,active,created) VALUES(?,?,?,?,1,?) ON CONFLICT(id) DO UPDATE SET token=excluded.token,username=excluded.username,owner_id=excluded.owner_id,active=1`, [id, enc(token), me.username, String(owner), Date.now()]);
  cache.delete(id);
  await tg(token, 'setWebhook', { url: `${BASE}/wh/${id}`, secret_token: sec(id), allowed_updates: ['message'] });
  return { id, username: me.username };
}
async function ensureUser(b, id, name, ref) {
  const r = await q('INSERT OR IGNORE INTO users(bot_id,tg_id,name,balance,created) VALUES(?,?,?,0,?)', [b, id, name || '', Date.now()]);
  if (!r.rowsAffected || !ref || ref === id) return;
  if (!(await one('SELECT 1 x FROM users WHERE bot_id=? AND tg_id=?', [b, ref]))) return;
  const c = await cfg(b);
  await txn(async t => {
    await t.execute({ sql: 'UPDATE users SET ref_by=? WHERE bot_id=? AND tg_id=?', args: [ref, b, id] });
    if (c.ref > 0) await add(t, b, ref, c.ref, 'referral', `user ${id}`);
  });
}

const app = express();
app.use(express.json());
const H = f => (req, res) => f(req, res).catch(e => res.status(400).json({ error: e.message }));

// ---- Telegram webhook (har bir bot uchun /wh/<botId>) ----
app.post('/wh/:id', async (req, res) => {
  res.sendStatus(200);
  try {
    const bot = await getBot(req.params.id);
    if (!bot || !bot.active || req.get('x-telegram-bot-api-secret-token') !== sec(bot.id)) return;
    const m = req.body.message; if (!m?.text?.startsWith('/start')) return;
    const ref = (m.text.split(' ')[1] || '').replace('ref_', '');
    await ensureUser(bot.id, String(m.from.id), m.from.first_name, ref);
    await tg(bot.token, 'sendMessage', { chat_id: m.chat.id, text: '🎲 PvP duel: Stars tikib o’ynang!', reply_markup: { inline_keyboard: [[{ text: '🎮 O’yinni ochish', web_app: { url: `${BASE}/app/${bot.id}` } }]] } });
  } catch (e) { console.error(e); }
});

// ---- Factory uchun (homiy shu endpointni chaqiradi) ----
const factory = (req, res, next) => (E.FACTORY_SECRET && req.get('x-factory-secret') === E.FACTORY_SECRET) ? next() : res.status(403).json({ error: 'forbidden' });
app.post('/api/factory/register', factory, H(async (req, res) => res.json(await registerBot(req.body.token, req.body.ownerId))));
app.post('/api/factory/disable', factory, H(async (req, res) => {
  const b = await getBot(String(req.body.botId)); if (!b) throw new Error('bot topilmadi');
  await q('UPDATE bots SET active=0 WHERE id=?', [b.id]); cache.delete(b.id); await tg(b.token, 'deleteWebhook'); res.json({ ok: true });
}));

// ---- Mini App auth (initData tekshiruvi) ----
const auth = (req, res, next) => (async () => {
  const b = req.get('x-bot'), bot = await getBot(b || '');
  if (!bot || !bot.active) return res.status(401).json({ error: 'bot yo‘q' });
  const p = new URLSearchParams(req.get('x-init') || ''), hash = p.get('hash'); p.delete('hash');
  const s = [...p.entries()].sort(([a], [c]) => a < c ? -1 : 1).map(([k, v]) => `${k}=${v}`).join('\n');
  const key = crypto.createHmac('sha256', 'WebAppData').update(bot.token).digest();
  if (crypto.createHmac('sha256', key).update(s).digest('hex') !== hash || Date.now() / 1000 - p.get('auth_date') > 86400) return res.status(401).json({ error: 'auth xato' });
  const u = JSON.parse(p.get('user'));
  req.u = { b: bot.id, id: String(u.id), name: u.first_name }; req.bot = bot;
  req.admin = req.u.id === bot.owner || req.u.id === String(E.OWNER_ID || '');
  await ensureUser(bot.id, req.u.id, u.first_name);
  next();
})().catch(e => res.status(500).json({ error: e.message }));
const adminOnly = (req, res, next) => req.admin ? next() : res.status(403).json({ error: 'faqat admin' });

// ---- O‘yinchi API ----
app.get('/api/me', auth, H(async (req, res) => {
  const { b, id } = req.u, c = await cfg(b);
  const u = await one('SELECT balance FROM users WHERE bot_id=? AND tg_id=?', [b, id]);
  const n = await one('SELECT COUNT(*) n FROM users WHERE bot_id=? AND ref_by=?', [b, id]);
  const h = (await q(`SELECT bet,winner,fee,status,ts FROM games WHERE bot_id=? AND (p1=? OR p2=?) AND status='done' ORDER BY id DESC LIMIT 15`, [b, id, id])).rows;
  res.json({ balance: Number(u.balance), admin: req.admin, cfg: c, name: req.u.name, refCount: Number(n.n), refLink: `https://t.me/${req.bot.username}?start=ref_${id}`,
    hist: h.map(g => ({ bet: Number(g.bet), win: g.winner === id, gain: Number(g.bet) * 2 - Number(g.fee), ts: Number(g.ts) })) });
}));

app.post('/api/promo', auth, H(async (req, res) => {
  const { b, id } = req.u, code = String(req.body.code || '').trim().toUpperCase();
  res.json(await txn(async t => {
    const p = (await t.execute({ sql: 'SELECT * FROM promos WHERE bot_id=? AND code=? AND active=1', args: [b, code] })).rows[0];
    if (!p || p.used >= p.max) throw new Error('Promokod topilmadi yoki tugagan');
    try { await t.execute({ sql: 'INSERT INTO promo_uses(bot_id,code,tg_id) VALUES(?,?,?)', args: [b, code, id] }); } catch { throw new Error('Bu promokod allaqachon ishlatilgan'); }
    await t.execute({ sql: 'UPDATE promos SET used=used+1 WHERE bot_id=? AND code=?', args: [b, code] });
    await add(t, b, id, Number(p.stars), 'promo', code);
    return { stars: Number(p.stars) };
  }));
}));

const roll = () => crypto.randomInt(1, 7) + crypto.randomInt(1, 7);
app.post('/api/pvp/play', auth, H(async (req, res) => {
  const { b, id } = req.u, bet = Math.floor(+req.body.bet), c = await cfg(b);
  if (!(bet >= c.min)) throw new Error(`Minimal stavka ${c.min} Stars`);
  res.json(await txn(async t => {
    const d = await t.execute({ sql: 'UPDATE users SET balance=balance-? WHERE bot_id=? AND tg_id=? AND balance>=?', args: [bet, b, id, bet] });
    if (!d.rowsAffected) throw new Error('Balans yetarli emas');
    await t.execute({ sql: 'INSERT INTO tx(bot_id,tg_id,amount,type,note,ts) VALUES(?,?,?,?,?,?)', args: [b, id, -bet, 'bet', '', Date.now()] });
    const w = (await t.execute({ sql: `SELECT id,p1 FROM games WHERE bot_id=? AND status='waiting' AND bet=? AND p1<>? ORDER BY id LIMIT 1`, args: [b, bet, id] })).rows[0];
    if (!w) { const r = await t.execute({ sql: `INSERT INTO games(bot_id,bet,p1,status,ts) VALUES(?,?,?,'waiting',?)`, args: [b, bet, id, Date.now()] }); return { waiting: Number(r.lastInsertRowid) }; }
    let a, o; do { a = roll(); o = roll(); } while (a === o);
    const win = a > o ? w.p1 : id, pot = bet * 2, fee = Math.floor(pot * c.fee / 100);
    const u = await t.execute({ sql: `UPDATE games SET p2=?,r1=?,r2=?,winner=?,fee=?,status='done' WHERE id=? AND status='waiting'`, args: [id, a, o, win, fee, w.id] });
    if (!u.rowsAffected) throw new Error('Qayta urinib ko‘ring');
    await add(t, b, win, pot - fee, 'win', `game ${w.id}`);
    return { done: true, you: o, opp: a, win: win === id, gain: pot - fee };
  }));
}));
app.get('/api/pvp/status/:gid', auth, H(async (req, res) => {
  const { b, id } = req.u, g = await one('SELECT * FROM games WHERE id=? AND bot_id=? AND p1=?', [req.params.gid, b, id]);
  if (!g) throw new Error('topilmadi');
  if (g.status !== 'done') return res.json({ waiting: g.status === 'waiting', cancelled: g.status === 'cancelled' });
  res.json({ done: true, you: Number(g.r1), opp: Number(g.r2), win: g.winner === id, gain: Number(g.bet) * 2 - Number(g.fee) });
}));
app.post('/api/pvp/cancel', auth, H(async (req, res) => {
  const { b, id } = req.u;
  res.json(await txn(async t => {
    const g = (await t.execute({ sql: `SELECT bet FROM games WHERE id=? AND bot_id=? AND p1=? AND status='waiting'`, args: [req.body.id, b, id] })).rows[0];
    if (!g) return { cancelled: false };
    await t.execute({ sql: `UPDATE games SET status='cancelled' WHERE id=?`, args: [req.body.id] });
    await add(t, b, id, Number(g.bet), 'refund'); return { cancelled: true };
  }));
}));

// ---- Admin API ----
const A = [auth, adminOnly];
app.get('/api/admin/stats', A, H(async (req, res) => {
  const b = req.u.b;
  const s = await one(`SELECT (SELECT COUNT(*) FROM users WHERE bot_id=?1) users, (SELECT COALESCE(SUM(balance),0) FROM users WHERE bot_id=?1) bal,
    (SELECT COUNT(*) FROM games WHERE bot_id=?1 AND status='done') games, (SELECT COALESCE(SUM(bet*2),0) FROM games WHERE bot_id=?1 AND status='done') volume,
    (SELECT COALESCE(SUM(fee),0) FROM games WHERE bot_id=?1) fees, (SELECT COUNT(*) FROM users WHERE bot_id=?1 AND ref_by IS NOT NULL) refs`, [b]);
  res.json(Object.fromEntries(Object.entries(s).map(([k, v]) => [k, Number(v)])));
}));
app.get('/api/admin/users', A, H(async (req, res) => {
  const t = `%${req.query.q || ''}%`;
  res.json((await q(`SELECT tg_id,name,balance FROM users WHERE bot_id=? AND (name LIKE ? OR tg_id LIKE ?) ORDER BY created DESC LIMIT 30`, [req.u.b, t, t])).rows.map(r => ({ id: r.tg_id, name: r.name, balance: Number(r.balance) })));
}));
app.post('/api/admin/give', A, H(async (req, res) => {
  const amt = Math.floor(+req.body.amount), to = String(req.body.tgId).trim();
  if (!amt || amt < 1) throw new Error('Miqdor noto‘g‘ri');
  res.json(await txn(async t => {
    if (!(await t.execute({ sql: 'SELECT 1 FROM users WHERE bot_id=? AND tg_id=?', args: [req.u.b, to] })).rows.length) throw new Error('Foydalanuvchi topilmadi (botga /start bosgan bo‘lishi kerak)');
    await add(t, req.u.b, to, amt, 'admin', `by ${req.u.id}`); return { ok: true };
  }));
}));
app.get('/api/admin/promos', A, H(async (req, res) => res.json((await q('SELECT code,stars,max,used,active FROM promos WHERE bot_id=? ORDER BY rowid DESC', [req.u.b])).rows.map(r => ({ code: r.code, stars: Number(r.stars), max: Number(r.max), used: Number(r.used), active: !!r.active })))));
app.post('/api/admin/promo', A, H(async (req, res) => {
  const code = String(req.body.code || '').trim().toUpperCase(), stars = Math.floor(+req.body.stars), max = Math.floor(+req.body.max);
  if (!/^[A-Z0-9_-]{3,20}$/.test(code) || !(stars > 0) || !(max > 0)) throw new Error('Kod (3-20 belgi), Stars va limitni tekshiring');
  try { await q('INSERT INTO promos(bot_id,code,stars,max) VALUES(?,?,?,?)', [req.u.b, code, stars, max]); } catch { throw new Error('Bunday kod bor'); }
  res.json({ ok: true });
}));
app.post('/api/admin/promo/toggle', A, H(async (req, res) => { await q('UPDATE promos SET active=1-active WHERE bot_id=? AND code=?', [req.u.b, req.body.code]); res.json({ ok: true }); }));
app.post('/api/admin/settings', A, H(async (req, res) => {
  for (const k of ['min', 'fee', 'ref']) { const v = Math.floor(+req.body[k]); if (Number.isFinite(v) && v >= 0 && (k !== 'min' || v >= 1) && (k !== 'fee' || v <= 50)) await q('INSERT INTO settings(bot_id,k,v) VALUES(?,?,?) ON CONFLICT(bot_id,k) DO UPDATE SET v=excluded.v', [req.u.b, k, v]); }
  res.json(await cfg(req.u.b));
}));
app.get('/api/admin/games', A, H(async (req, res) => res.json((await q(`SELECT id,bet,p1,p2,winner,fee,ts FROM games WHERE bot_id=? AND status='done' ORDER BY id DESC LIMIT 30`, [req.u.b])).rows.map(r => ({ id: Number(r.id), bet: Number(r.bet), p1: r.p1, p2: r.p2, winner: r.winner, fee: Number(r.fee), ts: Number(r.ts) })))));

app.get('/app/:id', (req, res) => res.sendFile(path.join(dir, 'public/index.html')));
app.get('/', (req, res) => res.send('ok'));
app.listen(PORT, async () => {
  console.log('listening', PORT);
  if (E.BOT_TOKEN && E.OWNER_ID && BASE) { try { console.log('bot', await registerBot(E.BOT_TOKEN, E.OWNER_ID)); } catch (e) { console.error(e.message); } }
});