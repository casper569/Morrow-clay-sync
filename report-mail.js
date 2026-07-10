/**
 * report-mail.js — mailt het Lemlist-weekrapport (huisstijl-PDF) naar je eigen adres.
 *   PERIOD=daily  -> "gisteren"      (dagelijkse mail)
 *   PERIOD=weekly -> "vorige week"   (wekelijkse mail, ma–zo)
 * Bouwt de opgemaakte HTML -> PDF (headless Chromium), hangt 'm als bijlage, en zet
 * de "Hé boss…"-tekst + Aandachtspunten in de body. Verstuurt via het Gmail-service-account
 * (GOOGLE_SA_KEY, zelfde als je offertebouwer).
 *
 * Env: LEMLIST_API_KEY, GOOGLE_SA_KEY, MAIL_TO(=casper@), MAIL_FROM(=MAIL_TO), PERIOD(daily|weekly),
 *      AMS_OFFSET(=+02:00, zomertijd; winter +01:00), DRY_RUN.
 * Deps: puppeteer (zie package.json).
 */
const fs = require('fs');
const crypto = require('node:crypto');

const LEMLIST_BASE = 'https://api.lemlist.com/api';
const KEY = process.env.LEMLIST_API_KEY;
const MAIL_TO = process.env.MAIL_TO || 'casper@wearemorrow.nl';
const MAIL_FROM = process.env.MAIL_FROM || MAIL_TO;
const PERIOD = (process.env.PERIOD || 'daily').toLowerCase();
const OFF = process.env.AMS_OFFSET || '+02:00';
const DRY = !!process.env.DRY_RUN;

const auth = { Authorization: 'Basic ' + Buffer.from(':' + KEY).toString('base64') };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ts = (x) => new Date(x).getTime();
const isLinkedin = (t) => String(t || '').toLowerCase().includes('linkedin');
const isReply = (t) => String(t || '').toLowerCase().includes('replied');
const esc = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const dom = (e) => (e || '').split('@')[1] || 'onbekend';

// ---- periode ----
function ymd(daysAgo) { return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Amsterdam' }).format(Date.now() - daysAgo * 864e5); }
function window_() {
  if (PERIOD === 'weekly') {
    // vorige volledige week ma–zo (Amsterdam)
    const todayStr = ymd(0);
    const dow = (new Date(todayStr + 'T12:00:00' + OFF).getDay() + 6) % 7; // 0 = maandag
    const thisMon = ts(todayStr + 'T00:00:00' + OFF) - dow * 864e5;
    const start = thisMon - 7 * 864e5, end = thisMon;
    return { start, end, word: 'vorige week', label: fmt(start) + ' – ' + fmt(end - 1) };
  }
  // gisteren
  const start = ts(ymd(1) + 'T00:00:00' + OFF), end = ts(ymd(0) + 'T00:00:00' + OFF);
  return { start, end, word: 'gisteren', label: fmt(start) };
}
const fmt = (ms) => new Date(ms).toLocaleDateString('nl-NL', { day: 'numeric', month: 'long', timeZone: 'Europe/Amsterdam' });

// ---- Lemlist ----
async function lemGet(path, params = {}) {
  const url = new URL(LEMLIST_BASE + path);
  Object.entries(params).forEach(([k, v]) => v != null && url.searchParams.set(k, v));
  for (let i = 0; i < 5; i++) {
    const res = await fetch(url, { headers: auth });
    if (res.status === 429) { await sleep(1000 * (+res.headers.get('Retry-After') || 2)); continue; }
    if (!res.ok) throw new Error(`Lemlist ${path} ${res.status}: ${await res.text()}`);
    await sleep(120); return res.json();
  }
  throw new Error('Rate limit: ' + path);
}
async function getActivities(from, to) {
  const out = []; let offset = 0;
  while (true) {
    const page = await lemGet('/activities', { limit: 100, offset, version: 'v2' });
    const rows = Array.isArray(page) ? page : (page.activities || page.data || []);
    if (!rows.length) break; out.push(...rows); if (rows.length < 100) break; offset += 100; if (offset > 50000) break;
  }
  return out.filter((a) => { const t = ts(a.date || a.createdAt); return t >= from && t <= to; });
}
async function getReplies(from, to, users, campMap) {
  const out = [];
  for (const userId of users) {
    let page = 1;
    while (true) {
      const res = await lemGet('/inbox', { userId, page, limit: 100 });
      for (const c of (res.data || [])) {
        const touched = c.lastRepliedAt || c.lastActivityAt;
        if (!touched || ts(touched) < from) continue;
        const msgs = await lemGet(`/inbox/${c.contactId || c._id}`, { userId, limit: 100 });
        for (const m of (msgs.data || [])) {
          if (!isReply(m.type)) continue;
          const t = ts(m.createdAt || m.sentAt || m.date); if (t < from || t > to) continue;
          out.push({ ...m, _campaign: campMap[m.campaignId] || '' });
        }
      }
      if (!res.pagination || !res.pagination.nextPage) break; page++;
    }
  }
  return out;
}

async function metrics(win) {
  const senders = await lemGet('/team/senders');
  const users = [...new Set(senders.map((s) => s.userId))];
  const campMap = {}; senders.forEach((s) => (s.campaigns || []).forEach((c) => (campMap[c._id] = c.name)));
  const acts = await getActivities(win.start, win.end);
  const sent = acts.filter((a) => String(a.type).toLowerCase() === 'emailssent');
  const bounced = acts.filter((a) => String(a.type).toLowerCase() === 'emailsbounced');
  const replies = await getReplies(win.start, win.end, users, campMap);
  const byDomain = {};
  for (const s of sent) (byDomain[dom(s.sendUserEmail)] ||= { sent: 0, bounced: 0 }).sent++;
  for (const b of bounced) (byDomain[dom(b.sendUserEmail)] ||= { sent: 0, bounced: 0 }).bounced++;
  const perCampagne = {}; for (const s of sent) { const k = campMap[s.campaignId] || s.campaignName || '—'; perCampagne[k] = (perCampagne[k] || 0) + 1; }
  const replyPerCampagne = {}; for (const r of replies) { const k = r._campaign || '—'; replyPerCampagne[k] = (replyPerCampagne[k] || 0) + 1; }
  const perDag = [0, 0, 0, 0, 0, 0, 0]; for (const s of sent) perDag[(new Date(s.date || s.createdAt).getUTCDay() + 6) % 7]++;
  // ---- ontdubbel naar UNIEKE reacties per lead (alleen voor de telling in het rapport) ----
  const keyOf = (r) => r.leadId || (r.leadEmail || '').toLowerCase() || (r.fromEmail || '').toLowerCase() || r.contactId || r._id;
  const byLead = new Map();
  for (const r of replies) {
    const k = keyOf(r); if (!k) continue;
    const rt = ts(r.createdAt || r.sentAt || r.date);
    let e = byLead.get(k);
    if (!e) { e = { linkedin: false, cc: false, interest: 0, step: r.sequenceStep, campaign: r._campaign || '', naam: [r.leadFirstName, r.leadLastName].filter(Boolean).join(' ') || r.leadEmail || r.fromEmail || 'onbekend', t: rt }; byLead.set(k, e); }
    if (isLinkedin(r.type)) e.linkedin = true;
    if (r.fromEmail && r.leadEmail && r.fromEmail.toLowerCase() !== r.leadEmail.toLowerCase()) e.cc = true;
    e.interest = Math.max(e.interest, r.aiLeadInterestScore || 0);
    if (rt < e.t) { e.t = rt; e.step = r.sequenceStep; e.campaign = r._campaign || e.campaign; }
  }
  const leads = [...byLead.values()];
  const replyLeadsPerCampagne = {}; for (const e of leads) { const k = e.campaign || '—'; replyLeadsPerCampagne[k] = (replyLeadsPerCampagne[k] || 0) + 1; }
  const perStep = {}; for (const e of leads) { const k = (e.step ?? '?'); perStep[k] = (perStep[k] || 0) + 1; }
  const seg = { pos: 0, twijfel: 0, niet: 0 }; for (const e of leads) { if (e.interest >= 0.5) seg.pos++; else if (e.interest >= 0.2) seg.twijfel++; else seg.niet++; }
  return { sent: sent.length, bounced: bounced.length, replies, uniek: leads.length,
    linkedin: leads.filter((e) => e.linkedin).length,
    cc: leads.filter((e) => e.cc).length,
    positief: leads.filter((e) => e.interest >= 0.5).length,
    leads, seg, perStep, byDomain, perCampagne, replyLeadsPerCampagne, perDag };
}

// ---- HTML-rapport (huisstijl) ----
function logoUri() { for (const p of ['./morrow_logo.png', './assets/morrow_logo.png']) { try { return 'data:image/png;base64,' + fs.readFileSync(p).toString('base64'); } catch {} } return ''; }
const CSS = `@import url('https://fonts.googleapis.com/css2?family=Manrope:wght@500;700;800&display=swap');
@page{size:A4;margin:15mm 14mm}*{box-sizing:border-box}html,body{background:#fafaf5}body{font-family:'Manrope',Arial,Helvetica,sans-serif;color:#0a0a14;font-size:11px;line-height:1.4;margin:0}
.logo{height:30px;margin:0 0 10px}h1{font-size:20px;margin:0 0 2px;color:#4b0028;font-weight:800}.sub{color:#666;font-size:11px;margin-bottom:12px}
.card{border:1px solid #e6e6e8;border-radius:10px;padding:14px;margin-bottom:14px;background:#fff;page-break-inside:avoid}.ctitle{font-size:13px;font-weight:800;margin:0 0 2px;color:#4b0028}.csub{font-size:10px;color:#777;margin-bottom:10px}
table.tiles{width:100%;border-collapse:separate;border-spacing:8px 0}table.tiles td{border:1px solid #ececee;border-radius:8px;padding:9px;vertical-align:top}
.tlabel{color:#777;font-size:9.5px;margin-bottom:4px}.tval{font-size:18px;font-weight:bold}.tval .u{font-size:10px;color:#888;font-weight:bold}.delta{font-size:9.5px;margin-top:3px}.flat{color:#888}
table.funnel{width:100%;border-collapse:separate;border-spacing:3px 0;margin-top:2px}table.funnel td.step{border:1px solid #ececee;border-radius:8px;padding:8px 4px;text-align:center}table.funnel td.win{border-color:#1a8f4c;background:#eaf6ee}table.funnel td.arr{text-align:center;color:#b0b0b6;font-size:9px;width:30px}.fn{font-size:15px;font-weight:bold}.fl{font-size:8.5px;color:#777}.arr b{display:block;color:#8a8a90;font-size:8.5px}
table.data{width:100%;border-collapse:collapse;font-size:10.5px}table.data td{padding:7px 5px;border-bottom:1px solid #f0f0f2}table.data td:not(:first-child){text-align:right}
.cols{width:100%;border-collapse:separate;border-spacing:14px 0}.cols>tbody>tr>td{vertical-align:top;width:50%}.cols>tbody>tr>td>.card{height:100%;margin-bottom:0}.lab{font-size:10px;font-weight:bold;color:#666;margin:0 0 6px}.mt{margin-top:14px}
.foot{font-size:9px;color:#999;border-top:1px solid #eee;padding-top:9px;margin-top:6px}
.days td{text-align:center;vertical-align:bottom;padding:0 3px}.dbar{width:70%;margin:0 auto;background:#3a7afe;border-radius:4px 4px 0 0}.dbar.best{background:#1a8f4c}.dbar.z{background:#e0e0e2;height:2px}.dnum{font-size:10px;font-weight:bold}.dlab{font-size:8.5px;color:#888}
.bar{height:13px;border-radius:7px;overflow:hidden;background:#ececee}.bar span{display:block;height:100%;float:left}.s1{background:#2e7d5b}.s2{background:#9aa5b1}.s3{background:#d98a3d}
.legend span{display:inline-block;font-size:10px;color:#5b5b60;margin:8px 12px 0 0}.legend i{display:inline-block;width:9px;height:9px;border-radius:2px;margin-right:4px}
.bad{color:#c0392b;font-weight:bold}.good{color:#1a8f4c;font-weight:bold}`;

function nf(n) { return Number(n).toLocaleString('nl-NL'); }
function pct(n, d) { return d ? (100 * n / d).toFixed(1).replace('.', ',') : '0'; }

function reportHtml(m, win) {
  const reacties = m.uniek;
  const br = pct(m.bounced, m.sent);
  const dl = m.sent ? (100 - 100 * m.bounced / m.sent).toFixed(1).replace('.', ',') : '0';
  const convReact = pct(reacties, m.sent);
  const DAYS = ['ma', 'di', 'wo', 'do', 'vr', 'za', 'zo']; const mx = Math.max(1, ...m.perDag);
  const days = PERIOD === 'weekly' ? `<div class="card"><div class="ctitle">Verzonden per dag</div><table class="days mt" width="100%"><tr>${m.perDag.map((v, i) => `<td><div class="dbar${v ? '' : ' z'}" style="height:${v ? Math.round(52 * v / mx) : 2}px"></div><div class="dnum">${v}</div><div class="dlab">${DAYS[i]}</div></td>`).join('')}</tr></table></div>` : '';
  const segTot = Math.max(1, m.seg.pos + m.seg.twijfel + m.seg.niet);
  const seg = `<div class="bar mt"><span class="s1" style="width:${100 * m.seg.pos / segTot}%"></span><span class="s3" style="width:${100 * m.seg.twijfel / segTot}%"></span><span class="s2" style="width:${100 * m.seg.niet / segTot}%"></span></div>
    <div class="legend"><span><i class="s1"></i>Positief · ${m.seg.pos}</span><span><i class="s3"></i>Twijfel · ${m.seg.twijfel}</span><span><i class="s2"></i>Niet interessant · ${m.seg.niet}</span></div>`;
  const stepRows = Object.entries(m.perStep).sort((a, b) => String(a[0]).localeCompare(String(b[0])))
    .map(([s, n]) => `<tr><td>${s === '?' ? 'Onbekend' : (s == 0 ? '1e mail (stap 0)' : 'Stap ' + s)}</td><td>${n}</td></tr>`).join('') || '<tr><td>—</td><td>0</td></tr>';
  const camp = Object.entries(m.perCampagne).sort((a, b) => b[1] - a[1]).slice(0, 6)
    .map(([c, s]) => `<tr><td>${esc(c)}</td><td>${pct(m.replyLeadsPerCampagne[c] || 0, s)}%</td></tr>`).join('') || '<tr><td>—</td><td>0%</td></tr>';
  const domr = Object.entries(m.byDomain).sort((a, b) => b[1].sent - a[1].sent).map(([d, v]) => {
    const bp = v.sent ? Math.round(100 * v.bounced / v.sent) : 0;
    return `<tr><td>${esc(d)}</td><td class="${bp >= 20 ? 'bad' : (bp === 0 ? 'good' : '')}">${v.sent} verz. · ${bp}%</td></tr>`;
  }).join('') || '<tr><td>—</td><td></td></tr>';

  return `<!DOCTYPE html><html lang="nl"><head><meta charset="utf-8"><style>${CSS}</style></head><body>
    <img src="${logoUri()}" class="logo"><h1>Lemlist · Outreach ${PERIOD === 'weekly' ? 'weekrapport' : 'dagrapport'}</h1>
    <div class="sub">${win.label} &nbsp;·&nbsp; echte data</div>

    <div class="card"><div class="ctitle">Outreach-funnel</div><div class="csub">E-mail + LinkedIn · reacties geteld per unieke persoon</div>
      <table class="funnel"><tr>
        <td class="step"><div class="fn">${nf(m.sent)}</div><div class="fl">Verzonden</div></td>
        <td class="arr">&#9654;</td>
        <td class="step"><div class="fn">${nf(m.sent)}</div><div class="fl">Nieuwe contacten</div></td>
        <td class="arr"><b>${convReact}%</b>&#9654;</td>
        <td class="step"><div class="fn">${reacties}</div><div class="fl">Reacties</div></td>
        <td class="arr">&#9654;</td>
        <td class="step win"><div class="fn">${m.positief}</div><div class="fl">Positief</div></td>
      </tr></table>
    </div>

    <div class="card"><div class="ctitle">Kerncijfers</div>
      <table class="tiles"><tr>
        <td style="width:16.6%"><div class="tlabel">Mails verzonden</div><div class="tval">${nf(m.sent)}</div></td>
        <td style="width:16.6%"><div class="tlabel">Reacties (uniek)</div><div class="tval">${reacties} <span class="u">·${convReact}%</span></div></td>
        <td style="width:16.6%"><div class="tlabel">w.v. LinkedIn</div><div class="tval">${m.linkedin}</div></td>
        <td style="width:16.6%"><div class="tlabel">w.v. via CC</div><div class="tval">${m.cc}</div></td>
        <td style="width:16.6%"><div class="tlabel">Bounces</div><div class="tval">${nf(m.bounced)} <span class="u">·${br}%</span></div></td>
        <td style="width:16.6%"><div class="tlabel">Deliverability</div><div class="tval">${dl}%</div></td>
      </tr></table>
    </div>

    ${days}

    <table class="cols"><tr>
      <td><div class="card">
        <div class="ctitle" style="font-size:12px">Reacties gesegmenteerd</div>${seg}
        <div class="lab mt">Reactie per sequence-stap</div>
        <table class="data">${stepRows}</table>
      </div></td>
      <td><div class="card">
        <div class="ctitle" style="font-size:12px">Campagne-prestaties (reply-rate)</div>
        <table class="data mt">${camp}</table>
        <div class="lab mt">Deliverability per afzenderdomein</div>
        <table class="data">${domr}</table>
      </div></td>
    </tr></table>

    <div class="foot">Automatisch gegenereerd · reacties per unieke persoon (incl. CC &amp; LinkedIn) · Morrow.</div></body></html>`;
}
async function htmlToPdf(html) {
  const puppeteer = require('puppeteer');
  const browser = await puppeteer.launch({ args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  try { const p = await browser.newPage(); await p.setContent(html, { waitUntil: 'networkidle0' }); return await p.pdf({ format: 'A4', printBackground: true, margin: { top: '15mm', bottom: '15mm', left: '14mm', right: '14mm' } }); }
  finally { await browser.close(); }
}

// ---- Aandachtspunten ----
function aandachtspunten(m) {
  const p = [];
  for (const [d, v] of Object.entries(m.byDomain)) if (v.sent >= 5 && v.bounced / v.sent > 0.2) p.push(`Afzenderdomein ${d} bounct ${Math.round(100 * v.bounced / v.sent)}% — deliverability-lek, checken.`);
  const hot = m.leads.filter((e) => e.interest >= 0.5).map((e) => e.naam);
  if (hot.length) p.push(`${hot.length} mogelijk geïnteresseerde reactie(s): ${hot.slice(0, 5).join(', ')}.`);
  if (m.cc) p.push(`${m.cc} reactie(s) via een CC-contact (miste de webhook).`);
  if (m.linkedin) p.push(`${m.linkedin} reactie(s) via LinkedIn.`);
  if (!m.uniek) p.push('Geen reacties in deze periode.');
  return p;
}

// ---- Gmail-verzending met bijlage (zelfde methode als offertebouwer) ----
const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
function parseSA() {
  let raw = (process.env.GOOGLE_SA_KEY || '').trim();
  if (raw.length > 1 && ((raw[0] === '"' && raw.endsWith('"')) || (raw[0] === "'" && raw.endsWith("'")))) raw = raw.slice(1, -1).trim();
  try { return JSON.parse(raw); }
  catch (e) { throw new Error(`GOOGLE_SA_KEY is geen geldige JSON (lengte ${raw.length}, begint met "${raw.slice(0, 8)}"). Plak de VOLLEDIGE service-account-JSON, van { t/m }, zonder tekst of aanhalingstekens eromheen.`); }
}
async function gmailSend({ from, to, subject, html, attachment }) {
  const sa = parseSA();
  const now = Math.floor(Date.now() / 1000);
  const hdr = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const clm = b64url(JSON.stringify({ iss: sa.client_email, sub: from, scope: 'https://www.googleapis.com/auth/gmail.send', aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 }));
  const input = `${hdr}.${clm}`;
  const sig = b64url(crypto.sign('RSA-SHA256', Buffer.from(input), sa.private_key));
  const tok = await (await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${input}.${sig}` }) })).json();
  if (!tok.access_token) throw new Error('Geen access_token: ' + JSON.stringify(tok).slice(0, 200));
  const bnd = `mix_${crypto.randomBytes(8).toString('hex')}`;
  const parts = [
    `From: ${from}`, `To: ${to}`, `Subject: =?UTF-8?B?${Buffer.from(subject, 'utf8').toString('base64')}?=`, 'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${bnd}"`, '', `--${bnd}`, 'Content-Type: text/html; charset=UTF-8', '', html,
    `--${bnd}`, `Content-Type: application/pdf; name="${attachment.filename}"`, 'Content-Transfer-Encoding: base64', `Content-Disposition: attachment; filename="${attachment.filename}"`, '', attachment.base64.replace(/(.{76})/g, '$1\r\n'), `--${bnd}--`,
  ].join('\r\n');
  const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', { method: 'POST', headers: { Authorization: `Bearer ${tok.access_token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ raw: b64url(Buffer.from(parts, 'utf8')) }) });
  if (!res.ok) throw new Error(`Gmail send ${res.status}: ${(await res.text()).slice(0, 200)}`);
}

async function main() {
  if (!KEY) throw new Error('LEMLIST_API_KEY ontbreekt');
  const win = window_();
  const m = await metrics(win);
  console.log(`${PERIOD} (${win.word}, ${win.label}): verzonden ${m.sent}, bounces ${m.bounced}, reply-events ${m.replies.length}, unieke reacties ${m.uniek} (LinkedIn ${m.linkedin}, CC ${m.cc}).`);

  const pdf = await htmlToPdf(reportHtml(m, win));
  const fname = `Lemlist_${PERIOD === 'weekly' ? 'week' : 'dag'}_${ymd(PERIOD === 'weekly' ? 7 : 1)}.pdf`;
  const punten = aandachtspunten(m);
  const body = `<div style="font-family:Arial,Helvetica,sans-serif;color:#1a1a1a;line-height:1.6;max-width:560px;">
    <p>Hé boss,</p>
    <p>Hierbij het rapport met je Lemlist-resultaten van <b>${win.word}</b> — zie de PDF in de bijlage.</p>
    <p><b>Aandachtspunten:</b></p>
    <ul>${punten.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>
    <p style="color:#999;font-size:12px;margin-top:22px;">Automatisch · Morrow.</p></div>`;

  if (DRY || !process.env.GOOGLE_SA_KEY) { fs.writeFileSync(fname, pdf); console.log(`(DRY of geen GOOGLE_SA_KEY) — PDF lokaal opgeslagen als ${fname}, geen mail.`); return; }
  await gmailSend({ from: MAIL_FROM, to: MAIL_TO, subject: `Lemlist ${PERIOD === 'weekly' ? 'weekrapport' : 'dagrapport'} — ${win.label}`, html: body, attachment: { filename: fname, base64: Buffer.from(pdf).toString('base64') } });
  console.log(`Mail met bijlage verstuurd naar ${MAIL_TO}.`);
}
if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
module.exports = { window_, reportHtml, aandachtspunten, ymd };
