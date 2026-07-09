/**
 * clay-sync.js — vult je Clay-tabel compleet uit Lemlist.
 *
 * MODE=gap  (standaard): stuurt ALLEEN de CC-replies + LinkedIn-antwoorden die de
 *                        webhook mist. Geen dubbelingen; webhook blijft de rest doen.
 * MODE=full            : stuurt ALLE events (sent + bounced + alle replies). Zet dan
 *                        de Lemlist-webhook UIT, anders komt sent/bounced dubbel binnen.
 *
 * Dedupe zit in het script (clay-sent-ids.json), dus dagelijks draaien geeft nooit dubbel.
 * Eén los bestand, geen installatie nodig (Node 18+).
 *
 * Testen:
 *   1) alleen kijken:   DRY_RUN=1 node clay-sync.js
 *   2) echt sturen:     node clay-sync.js
 *
 * Env: LEMLIST_API_KEY (altijd), CLAY_WEBHOOK_URL (om te sturen).
 * Optioneel: MODE(gap|full, default gap), LOOKBACK_DAYS(=7), LIMIT, DRY_RUN, DEBUG.
 */
const fs = require('fs');
const LEMLIST_BASE = 'https://api.lemlist.com/api';
const KEY = process.env.LEMLIST_API_KEY;
const CLAY_URL = process.env.CLAY_WEBHOOK_URL;
const MODE = (process.env.MODE || 'gap').toLowerCase();
const LOOKBACK_DAYS = +(process.env.LOOKBACK_DAYS || 7);
const LIMIT = +(process.env.LIMIT || 0);
const DRY = !!process.env.DRY_RUN;
const LEDGER = './clay-sent-ids.json';

const auth = { Authorization: 'Basic ' + Buffer.from(':' + KEY).toString('base64') };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ts = (x) => new Date(x).getTime();
const stripHtml = (h) => (h || '').replace(/<[^>]+>/g, ' ').replace(/&[a-z]+;/gi, ' ').replace(/\s+/g, ' ').trim().slice(0, 1000);
const dedupe = (a, fn) => { const s = new Set(); return a.filter((x) => { const k = fn(x); if (s.has(k)) return false; s.add(k); return true; }); };
const isLinkedin = (t) => String(t || '').toLowerCase().includes('linkedin');
const isReply = (t) => String(t || '').toLowerCase().includes('replied');
const loadLedger = () => { try { return new Set(JSON.parse(fs.readFileSync(LEDGER, 'utf8'))); } catch { return new Set(); } };
const saveLedger = (set) => fs.writeFileSync(LEDGER, JSON.stringify([...set]));

async function lemGet(path, params = {}) {
  const url = new URL(LEMLIST_BASE + path);
  Object.entries(params).forEach(([k, v]) => v != null && url.searchParams.set(k, v));
  for (let i = 0; i < 5; i++) {
    const res = await fetch(url, { headers: auth });
    if (res.status === 429) { await sleep(1000 * (+res.headers.get('Retry-After') || 2)); continue; }
    if (!res.ok) throw new Error(`Lemlist ${path} ${res.status}: ${await res.text()}`);
    await sleep(120);
    return res.json();
  }
  throw new Error('Rate limit bleef aanhouden: ' + path);
}

async function getActivities(from, to) {
  const out = []; let offset = 0;
  while (true) {
    const page = await lemGet('/activities', { limit: 100, offset, version: 'v2' });
    const rows = Array.isArray(page) ? page : (page.activities || page.data || []);
    if (!rows.length) break;
    out.push(...rows);
    if (rows.length < 100) break;
    offset += 100; if (offset > 50000) break;
  }
  return out.filter((a) => { const t = ts(a.date || a.createdAt); return t >= from && t <= to; });
}

async function getReplies(from, to, users, campMap) {
  const out = []; let debug = !!process.env.DEBUG;
  for (const userId of users) {
    let page = 1;
    while (true) {
      const res = await lemGet('/inbox', { userId, page, limit: 100 });
      const convs = res.data || [];
      if (debug && convs[0]) console.error('DEBUG conv:\n' + JSON.stringify(convs[0], null, 2));
      for (const c of convs) {
        const touched = c.lastRepliedAt || c.lastActivityAt;
        if (!touched || ts(touched) < from) continue;
        const msgs = await lemGet(`/inbox/${c.contactId || c._id}`, { userId, limit: 100 });
        const list = msgs.data || [];
        if (debug && list[0]) { console.error('DEBUG msg:\n' + JSON.stringify(list[0], null, 2)); debug = false; }
        for (const m of list) {
          if (!isReply(m.type)) continue;
          const t = ts(m.createdAt || m.sentAt || m.date); if (t < from || t > to) continue;
          m._campaign = campMap[m.campaignId] || '';
          out.push(m);
        }
      }
      if (!res.pagination || !res.pagination.nextPage) break;
      page++;
    }
  }
  return out;
}

function normActivity(a, campMap) {
  return { event_id: a._id || a.id, type: a.type, date: a.date || a.createdAt, email: a.leadEmail || '',
    fromEmail: '', isCcReply: 'false', channel: isLinkedin(a.type) ? 'linkedin' : 'email', companyName: a.companyName || '',
    campaign: campMap[a.campaignId] || a.campaignName || '', sendUserEmail: a.sendUserEmail || '', sendUserName: a.sendUserName || '',
    sequenceStep: a.sequenceStep ?? '', subject: a.subject || '', text: '', leadId: a.leadId || '',
    firstName: a.leadFirstName || '', lastName: a.leadLastName || '', aiInterest: '' };
}
function normReply(m) {
  const cc = m.fromEmail && m.leadEmail && m.fromEmail.toLowerCase() !== m.leadEmail.toLowerCase();
  return { event_id: m._id, type: m.type, date: m.createdAt || m.sentAt || m.date, email: m.leadEmail || '', fromEmail: m.fromEmail || m.leadEmail || '',
    isCcReply: cc ? 'true' : 'false', channel: isLinkedin(m.type) ? 'linkedin' : 'email', companyName: m.companyName || '',
    campaign: m._campaign || '', sendUserEmail: m.sendUserEmail || '', sendUserName: m.sendUserName || '',
    sequenceStep: m.sequenceStep ?? '', subject: m.subject || '', text: m.text || stripHtml(m.message || m.body), leadId: m.leadId || '',
    firstName: m.leadFirstName || '', lastName: m.leadLastName || '', aiInterest: m.aiLeadInterestScore ?? '' };
}

async function main() {
  if (!KEY) throw new Error('LEMLIST_API_KEY ontbreekt');
  if (!DRY && !CLAY_URL) throw new Error('CLAY_WEBHOOK_URL ontbreekt');
  const to = Date.now(), from = to - LOOKBACK_DAYS * 864e5;

  const senders = await lemGet('/team/senders');
  const users = [...new Set(senders.map((s) => s.userId))];
  const campMap = {}; senders.forEach((s) => (s.campaigns || []).forEach((c) => (campMap[c._id] = c.name)));

  const acts = await getActivities(from, to);
  const sentBounced = acts.filter((a) => ['emailssent', 'emailsbounced'].includes(String(a.type || '').toLowerCase()));
  const replies = (await getReplies(from, to, users, campMap)).map(normReply);
  const all = dedupe([...sentBounced.map((a) => normActivity(a, campMap)), ...replies], (r) => r.event_id);

  const replyRows = all.filter((r) => isReply(r.type));
  const uniekeLeads = new Set(replyRows.map((r) => r.leadId).filter(Boolean)).size;
  console.log(`Laatste ${LOOKBACK_DAYS} dagen: verzonden ${all.filter((r) => r.type === 'emailsSent').length}, bounces ${all.filter((r) => r.type === 'emailsBounced').length}, reply-events ${replyRows.length} (unieke leads ${uniekeLeads}, LinkedIn ${replyRows.filter((r) => r.channel === 'linkedin').length}, CC ${replyRows.filter((r) => r.isCcReply === 'true').length}).`);

  // Kies wat naar Clay gaat
  let candidates = MODE === 'full' ? all : replyRows.filter((r) => r.channel === 'linkedin' || r.isCcReply === 'true');
  console.log(`Modus '${MODE}' — te sturen kandidaten: ${candidates.length}` + (MODE === 'full' ? ' (alles)' : ' (alleen CC + LinkedIn die de webhook mist)'));

  const ledger = loadLedger();
  candidates = candidates.filter((r) => !ledger.has(String(r.event_id)));
  console.log(`Nog niet eerder gestuurd: ${candidates.length}.`);
  if (LIMIT) candidates = candidates.slice(0, LIMIT);

  let ok = 0;
  for (const p of candidates) {
    if (DRY) { console.log(JSON.stringify(p)); continue; }
    const res = await fetch(CLAY_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(p) });
    if (res.ok) { ok++; ledger.add(String(p.event_id)); } else console.error('Clay POST faalde:', res.status, await res.text());
    await sleep(150);
  }
  if (!DRY) saveLedger(ledger);
  console.log(DRY ? 'DRY RUN klaar — niets naar Clay gestuurd.' : `Naar Clay gestuurd: ${ok}/${candidates.length}. (bewaard in ${LEDGER})`);
}
main().catch((e) => { console.error(e); process.exit(1); });
