/**
 * hubspot-report.js — mailt het HubSpot Sales-rapport (huisstijl-PDF).
 *   PERIOD=weekly  -> vorige volledige week (ma–zo)
 *   PERIOD=monthly -> vorige volledige kalendermaand
 * Haalt sales-cijfers uit HubSpot (EU-portal, api.hubapi.com), bouwt de opgemaakte
 * HTML -> PDF, en mailt via SMTP (zelfde als de Lemlist-rapporten).
 *
 * Env: HUBSPOT_TOKEN, SMTP_USER, SMTP_PASS, SMTP_HOST(=smtp.gmail.com), SMTP_PORT(=465),
 *      MAIL_FROM(=SMTP_USER), MAIL_TO(=MAIL_FROM), PERIOD(weekly|monthly),
 *      AMS_OFFSET(=+02:00), DRY_RUN.
 * Deps: puppeteer + nodemailer.
 */
const fs = require('fs');

const TOKEN = process.env.HUBSPOT_TOKEN;
const SMTP_HOST = process.env.SMTP_HOST || 'smtp.gmail.com';
const SMTP_PORT = +(process.env.SMTP_PORT || 465);
const SMTP_USER = process.env.SMTP_USER || '';
const SMTP_PASS = process.env.SMTP_PASS || '';
const MAIL_FROM = process.env.MAIL_FROM || SMTP_USER;
const MAIL_TO = process.env.MAIL_TO || MAIL_FROM;
const PERIOD = (process.env.PERIOD || 'weekly').toLowerCase();
const OFF = process.env.AMS_OFFSET || '+02:00';
const DRY = !!process.env.DRY_RUN;

// ---- HubSpot ID's (live hub 144015789) ----
const LEADS_PIPELINE = '3822091489';
const BELTAKEN_STAGE = '5390462186';
const BELTAKEN_ENTERED = 'hs_v2_date_entered_5390462186';
const DEALS_PIPELINE_NIEUW = '3871605999';
const AFSPRAAK_ENTERED = 'hs_v2_date_entered_5508107451';
const OFFERTES_OBJ = '2-204285639';
const OFFERTE_VOORBIJ_CONCEPT = ['Verstuurd', 'Bekeken', 'Geaccepteerd', 'Verlopen'];
const OWNERS = { '30818364': 'Olivier Huyzer', '34164648': 'Leadopvolgers', '403627646': 'Lex Burghouwt', '29504006': 'Steven Kooistra', '31960201': 'Casper' };
const AM_ORDER = ['30818364', '34164648', '403627646', '29504006'];

const ts = (x) => new Date(x).getTime();
const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const eur = (n) => '€ ' + Math.round(Number(n) || 0).toLocaleString('nl-NL');
const nf = (n) => Number(n).toLocaleString('nl-NL');
const MAAND = ['januari', 'februari', 'maart', 'april', 'mei', 'juni', 'juli', 'augustus', 'september', 'oktober', 'november', 'december'];

// ---- periode ----
function ymd(daysAgo) { return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Amsterdam' }).format(Date.now() - daysAgo * 864e5); }
function ymParts(daysAgo) { const [y, m, d] = ymd(daysAgo).split('-').map(Number); return { y, m, d }; }
function monthStartTs(y, m) { return ts(`${y}-${String(m).padStart(2, '0')}-01T00:00:00${OFF}`); }
const fmt = (ms) => new Date(ms).toLocaleDateString('nl-NL', { day: 'numeric', month: 'long', timeZone: 'Europe/Amsterdam' });
function window_() {
  if (PERIOD === 'monthly') {
    const { y, m } = ymParts(0);
    const end = monthStartTs(y, m);
    const py = m === 1 ? y - 1 : y, pm = m === 1 ? 12 : m - 1;
    return { start: monthStartTs(py, pm), end, label: MAAND[pm - 1] + ' ' + py, monthIdx: pm - 1, monthKey: `${py}-${String(pm).padStart(2, '0')}` };
  }
  const todayStr = ymd(0);
  const dow = (new Date(todayStr + 'T12:00:00' + OFF).getDay() + 6) % 7;
  const thisMon = ts(todayStr + 'T00:00:00' + OFF) - dow * 864e5;
  const start = thisMon - 7 * 864e5, end = thisMon;
  const mp = ymParts(0);
  return { start, end, label: fmt(start) + ' – ' + fmt(end - 1), monthIdx: mp.m - 1, monthKey: `${mp.y}-${String(mp.m).padStart(2, '0')}` };
}

// ---- HubSpot API ----
async function hsSearch(objectType, filterGroups, properties) {
  const out = []; let after;
  for (let i = 0; i < 60; i++) {
    const body = { filterGroups, properties, limit: 100 };
    if (after) body.after = after;
    const res = await fetch(`https://api.hubapi.com/crm/v3/objects/${objectType}/search`, {
      method: 'POST', headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    if (res.status === 429) { await new Promise((r) => setTimeout(r, 1000)); continue; }
    if (!res.ok) throw new Error(`HubSpot ${objectType} ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const j = await res.json();
    out.push(...(j.results || []));
    if (j.paging && j.paging.next && j.paging.next.after) { after = j.paging.next.after; await new Promise((r) => setTimeout(r, 120)); } else break;
  }
  return out;
}
const between = (prop, from, to) => ({ propertyName: prop, operator: 'BETWEEN', value: String(from), highValue: String(to) });
const byOwner = () => Object.fromEntries(AM_ORDER.map((o) => [o, 0]));
function tally(rows, into, val = () => 1) { for (const r of rows) { const o = r.properties.hubspot_owner_id; if (into[o] != null) into[o] += val(r); else (into._overig = (into._overig || 0) + val(r)); } }

async function metrics(win) {
  const P = (o) => o.properties;
  // Nieuw in Beltaken
  const nieuwRows = await hsSearch('leads', [{ filters: [{ propertyName: 'hs_pipeline', operator: 'EQ', value: LEADS_PIPELINE }, between(BELTAKEN_ENTERED, win.start, win.end)] }], ['hubspot_owner_id', BELTAKEN_ENTERED]);
  // Gebeld (voltooide beltaken)
  const gebeldRows = await hsSearch('tasks', [{ filters: [{ propertyName: 'hs_task_status', operator: 'EQ', value: 'COMPLETED' }, between('hs_task_completion_date', win.start, win.end), { propertyName: 'hs_task_subject', operator: 'CONTAINS_TOKEN', value: 'bellen' }] }], ['hubspot_owner_id', 'hs_task_subject']);
  // Afspraken ingepland (deals nieuwe pipeline)
  const afspraakRows = await hsSearch('deals', [{ filters: [{ propertyName: 'pipeline', operator: 'EQ', value: DEALS_PIPELINE_NIEUW }, between(AFSPRAAK_ENTERED, win.start, win.end)] }], ['hubspot_owner_id']);
  // Gewonnen deals (nieuwe pipeline, closedwon in window)
  const wonRows = await hsSearch('deals', [{ filters: [{ propertyName: 'pipeline', operator: 'EQ', value: DEALS_PIPELINE_NIEUW }, { propertyName: 'hs_is_closed_won', operator: 'EQ', value: 'true' }, between('closedate', win.start, win.end)] }], ['hubspot_owner_id', 'amount']);
  // Offertes (in window, excl. test)
  const offerteRows = (await hsSearch(OFFERTES_OBJ, [{ filters: [between('hs_createdate', win.start, win.end)] }], ['naam', 'status', 'bedrag', 'hubspot_owner_id']))
    .filter((o) => !/test/i.test(P(o).naam || ''));
  const offerteVerstuurd = offerteRows.filter((o) => OFFERTE_VOORBIJ_CONCEPT.includes(P(o).status));
  // Beltaken-veroudering (open leads nu in Beltaken)
  const openBeltaken = await hsSearch('leads', [{ filters: [{ propertyName: 'hs_pipeline', operator: 'EQ', value: LEADS_PIPELINE }, { propertyName: 'hs_pipeline_stage', operator: 'EQ', value: BELTAKEN_STAGE }] }], ['hubspot_owner_id', BELTAKEN_ENTERED]);
  const now = Date.now(); const veroudering = { '0-2': 0, '3-5': 0, '>5': 0 };
  for (const l of openBeltaken) { const d = (now - ts(P(l)[BELTAKEN_ENTERED])) / 864e5; if (d <= 2) veroudering['0-2']++; else if (d <= 5) veroudering['3-5']++; else veroudering['>5']++; }

  // per-owner aggregatie (owners buiten de AM-lijst of zonder eigenaar → "_overig")
  const perOwner = {}; for (const o of [...AM_ORDER, '_overig']) perOwner[o] = { nieuw: 0, gebeld: 0, afspraken: 0, offertes: 0, offerteEur: 0, gewonnen: 0, gewonnenEur: 0 };
  const bucket = (id) => (perOwner[id] ? id : '_overig');
  const add = (rows, key, val = () => 1) => { for (const r of rows) perOwner[bucket(P(r).hubspot_owner_id)][key] += val(r); };
  add(nieuwRows, 'nieuw'); add(gebeldRows, 'gebeld'); add(afspraakRows, 'afspraken');
  for (const o of offerteVerstuurd) { const b = perOwner[bucket(P(o).hubspot_owner_id)]; b.offertes++; b.offerteEur += Number(P(o).bedrag) || 0; }
  for (const d of wonRows) { const b = perOwner[bucket(P(d).hubspot_owner_id)]; b.gewonnen++; b.gewonnenEur += Number(P(d).amount) || 0; }

  // offerte-funnel per status
  const funnel = {}; for (const o of offerteRows) { const s = P(o).status || 'Onbekend'; funnel[s] = (funnel[s] || 0) + 1; }

  return {
    team: {
      nieuw: nieuwRows.length, gebeld: gebeldRows.length, afspraken: afspraakRows.length,
      offertes: offerteVerstuurd.length, offerteEur: offerteVerstuurd.reduce((s, o) => s + (Number(P(o).bedrag) || 0), 0),
      gewonnen: wonRows.length, gewonnenEur: wonRows.reduce((s, d) => s + (Number(P(d).amount) || 0), 0),
    },
    perOwner, funnel, veroudering, openBeltaken: openBeltaken.length,
  };
}

// ---- goals (maanddoelen per accountmanager) ----
function loadGoals() { try { return JSON.parse(fs.readFileSync('./sales-goals.json', 'utf8')); } catch { return {}; } }

// ---- HTML ----
function logoUri() { for (const p of ['./morrow_logo.png', './assets/morrow_logo.png']) { try { return 'data:image/png;base64,' + fs.readFileSync(p).toString('base64'); } catch {} } return ''; }
const CSS = `@import url('https://fonts.googleapis.com/css2?family=Manrope:wght@500;700;800&display=swap');
@page{size:A4;margin:15mm 14mm}*{box-sizing:border-box}html,body{background:#fff}body{font-family:'Manrope',Arial,Helvetica,sans-serif;color:#0a0a14;font-size:11px;line-height:1.4;margin:0}
.logo{height:30px;margin:0 0 10px}h1{font-size:20px;margin:0 0 2px;color:#4b0028;font-weight:800}.sub{color:#666;font-size:11px;margin-bottom:12px}
.card{border:1px solid #e6e6e8;border-radius:10px;padding:14px;margin-bottom:14px;background:#fff;page-break-inside:avoid}.ctitle{font-size:13px;font-weight:800;margin:0 0 2px;color:#4b0028}.csub{font-size:10px;color:#777;margin-bottom:10px}
table.tiles{width:100%;border-collapse:collapse;table-layout:fixed}table.tiles td{vertical-align:top;padding:0 4px}table.tiles td:first-child{padding-left:0}table.tiles td:last-child{padding-right:0}.tile{border:1px solid #ececee;border-radius:8px;padding:9px;height:100%}
.tlabel{color:#777;font-size:9.5px;margin-bottom:4px}.tval{font-size:17px;font-weight:bold}.tval .u{font-size:9.5px;color:#888;font-weight:bold}
table.data{width:100%;border-collapse:collapse;font-size:10.5px}table.data th{text-align:left;font-size:9px;text-transform:uppercase;letter-spacing:.03em;color:#888;padding:6px 5px;border-bottom:1px solid #e6e6e8}table.data td{padding:7px 5px;border-bottom:1px solid #f0f0f2}table.data th:not(:first-child),table.data td:not(:first-child){text-align:right}
.cols{width:100%;border-collapse:separate;border-spacing:14px 0}.cols>tbody>tr>td{vertical-align:top;width:50%}.cols>tbody>tr>td>.card{height:100%;margin-bottom:0}.lab{font-size:10px;font-weight:bold;color:#666;margin:0 0 6px}.mt{margin-top:14px}
.foot{font-size:9px;color:#999;border-top:1px solid #eee;padding-top:9px;margin-top:6px}
.bar{height:11px;border-radius:6px;overflow:hidden;background:#ececee}.bar span{display:block;height:100%;float:left}.b1{background:#1a8f4c}.b2{background:#e0912a}.b3{background:#c0392b}
.prog{height:8px;border-radius:5px;background:#ececee;overflow:hidden;margin-top:3px}.prog span{display:block;height:100%;background:#1a8f4c}.prog span.warn{background:#e0912a}.prog span.bad{background:#c0392b}
.gsub{font-size:9px;color:#8a8a90;margin-top:2px}.bad{color:#c0392b;font-weight:bold}.good{color:#1a8f4c;font-weight:bold}`;

function reportHtml(m, win, goals) {
  const t = m.team;
  const ov = m.perOwner._overig;
  const heeftOverig = ov && (ov.nieuw + ov.gebeld + ov.afspraken + ov.offertes + ov.gewonnen) > 0;
  const rows = [...AM_ORDER, ...(heeftOverig ? ['_overig'] : [])].map((o) => {
    const p = m.perOwner[o];
    const naam = o === '_overig' ? '<i style="color:#888;font-style:normal">Niet toegewezen</i>' : esc(OWNERS[o]);
    return `<tr><td>${naam}</td><td>${p.nieuw}</td><td>${p.gebeld}</td><td>${p.afspraken}</td><td>${p.offertes} · ${eur(p.offerteEur)}</td><td>${p.gewonnen} · ${eur(p.gewonnenEur)}</td></tr>`;
  }).join('');
  const funnelOrder = ['Concept', 'Verstuurd', 'Bekeken', 'Geaccepteerd', 'Verlopen'];
  const funnelRows = funnelOrder.filter((s) => m.funnel[s]).map((s) => `<tr><td>${s}</td><td>${m.funnel[s]}</td></tr>`).join('') || '<tr><td>Geen offertes deze periode</td><td>0</td></tr>';
  const vTot = Math.max(1, m.veroudering['0-2'] + m.veroudering['3-5'] + m.veroudering['>5']);
  const goalRows = AM_ORDER.map((o) => {
    const g = goals[o];
    const p = m.perOwner[o];
    if (!g) return `<tr><td>${esc(OWNERS[o])}</td><td colspan="3" style="text-align:left;color:#999">n.t.b. (doel niet ingevuld)</td></tr>`;
    const cell = (cur, doel, isEur) => {
      if (doel == null || doel === '') return '<span style="color:#999">n.t.b.</span>';
      const pct = doel > 0 ? Math.min(100, Math.round(cur / doel * 100)) : 0;
      const cls = cur >= doel ? '' : (cur >= 0.7 * doel ? 'warn' : 'bad');
      return `${isEur ? eur(cur) : cur} / ${isEur ? eur(doel) : doel}<div class="prog"><span class="${cls}" style="width:${pct}%"></span></div>`;
    };
    return `<tr><td>${esc(OWNERS[o])}</td><td>${cell(p.afspraken, g.afspraken)}</td><td>${cell(p.offertes, g.offertes)}</td><td>${cell(p.gewonnenEur, g.omzet, true)}</td></tr>`;
  }).join('');

  return `<!DOCTYPE html><html lang="nl"><head><meta charset="utf-8"><style>${CSS}</style></head><body>
    <img src="${logoUri()}" class="logo"><h1>HubSpot · Sales ${PERIOD === 'monthly' ? 'maandrapport' : 'weekrapport'}</h1>
    <div class="sub">${win.label} &nbsp;·&nbsp; echte data · Morrow sales</div>

    <div class="card"><div class="ctitle">Teamcijfers</div>
      <table class="tiles"><tr>
        <td><div class="tile"><div class="tlabel">Nieuw in Beltaken</div><div class="tval">${nf(t.nieuw)}</div></div></td>
        <td><div class="tile"><div class="tlabel">Gebeld</div><div class="tval">${nf(t.gebeld)}</div></div></td>
        <td><div class="tile"><div class="tlabel">Afspraken ingepland</div><div class="tval">${nf(t.afspraken)}</div></div></td>
        <td><div class="tile"><div class="tlabel">Offertes verstuurd</div><div class="tval">${nf(t.offertes)} <span class="u">·${eur(t.offerteEur)}</span></div></div></td>
        <td><div class="tile"><div class="tlabel">Gewonnen</div><div class="tval">${nf(t.gewonnen)} <span class="u">·${eur(t.gewonnenEur)}</span></div></div></td>
      </tr></table>
    </div>

    <div class="card"><div class="ctitle">Leaderboard per accountmanager</div>${heeftOverig ? '<div class="csub">Records zonder eigenaar in HubSpot (bijv. offertes uit de offertebouwer) vallen onder "Niet toegewezen".</div>' : ''}
      <table class="data"><thead><tr><th>Accountmanager</th><th>Nieuw</th><th>Gebeld</th><th>Afspraken</th><th>Offertes (# · €)</th><th>Gewonnen (# · €)</th></tr></thead><tbody>${rows}</tbody></table>
    </div>

    <table class="cols"><tr>
      <td><div class="card">
        <div class="ctitle" style="font-size:12px">Offerte-funnel</div><div class="csub">Morrow Offertes deze periode per status (test-records uitgesloten)</div>
        <table class="data">${funnelRows}</table>
      </div></td>
      <td><div class="card">
        <div class="ctitle" style="font-size:12px">Beltaken-veroudering</div><div class="csub">Open leads nu in Beltaken · ${m.openBeltaken} totaal</div>
        <div class="bar mt"><span class="b1" style="width:${100 * m.veroudering['0-2'] / vTot}%"></span><span class="b2" style="width:${100 * m.veroudering['3-5'] / vTot}%"></span><span class="b3" style="width:${100 * m.veroudering['>5'] / vTot}%"></span></div>
        <table class="data mt"><tr><td>0–2 dagen (vers)</td><td>${m.veroudering['0-2']}</td></tr><tr><td>3–5 dagen</td><td>${m.veroudering['3-5']}</td></tr><tr><td class="bad">Ouder dan 5 dagen</td><td class="bad">${m.veroudering['>5']}</td></tr></table>
      </div></td>
    </tr></table>

    <div class="card"><div class="ctitle">Maanddoelen per accountmanager · ${MAAND[win.monthIdx]}</div>
      <div class="csub">${PERIOD === 'monthly' ? 'Eindstand' : 'Maand-tot-nu'} vs. doel (ingevuld in de maandmeeting)</div>
      <table class="data"><thead><tr><th>Accountmanager</th><th>Afspraken</th><th>Offertes</th><th>Omzet getekend</th></tr></thead><tbody>${goalRows}</tbody></table>
    </div>

    <div class="foot">Automatisch gegenereerd · HubSpot hub 144015789 · offerte telt vanaf voorbij "Concept" · test-records uitgesloten · Morrow.</div></body></html>`;
}

async function htmlToPdf(html) {
  const puppeteer = require('puppeteer');
  const browser = await puppeteer.launch({ args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  try { const p = await browser.newPage(); await p.setContent(html, { waitUntil: 'networkidle0' }); return await p.pdf({ format: 'A4', printBackground: true, margin: { top: '15mm', bottom: '15mm', left: '14mm', right: '14mm' } }); }
  finally { await browser.close(); }
}

async function smtpSend({ from, to, subject, html, attachment }) {
  const nodemailer = require('nodemailer');
  const transport = nodemailer.createTransport({ host: SMTP_HOST, port: SMTP_PORT, secure: SMTP_PORT === 465, auth: { user: SMTP_USER, pass: SMTP_PASS } });
  await transport.sendMail({ from, to, subject, html, attachments: [{ filename: attachment.filename, content: attachment.buffer, contentType: 'application/pdf' }] });
}

function aandachtspunten(m) {
  const p = [];
  if (m.veroudering['>5']) p.push(`${m.veroudering['>5']} leads staan langer dan 5 dagen open in Beltaken — die verwateren.`);
  if (!m.team.gebeld) p.push('Geen voltooide beltaken deze periode — check of belactiviteit gelogd wordt.');
  if (m.team.offertes) p.push(`${m.team.offertes} offerte(s) verstuurd (${eur(m.team.offerteEur)}), waarvan ${m.team.gewonnen} gewonnen (${eur(m.team.gewonnenEur)}).`);
  if (!p.length) p.push('Rustige periode, geen bijzonderheden.');
  return p;
}

async function main() {
  if (!TOKEN) throw new Error('HUBSPOT_TOKEN ontbreekt');
  const win = window_();
  const m = await metrics(win);
  console.log(`${PERIOD} (${win.label}): nieuw ${m.team.nieuw}, gebeld ${m.team.gebeld}, afspraken ${m.team.afspraken}, offertes ${m.team.offertes} (${eur(m.team.offerteEur)}), gewonnen ${m.team.gewonnen}.`);

  const goals = (loadGoals()[win.monthKey]) || {};
  const pdf = await htmlToPdf(reportHtml(m, win, goals));
  const kind = PERIOD === 'monthly' ? 'maand' : 'week';
  const fname = `HubSpot_${kind}_${ymd(1)}.pdf`;
  const punten = aandachtspunten(m);
  const body = `<div style="font-family:Arial,Helvetica,sans-serif;color:#1a1a1a;line-height:1.6;max-width:560px;">
    <p>Hé boss,</p>
    <p>Hierbij het HubSpot sales-${kind}rapport (${esc(win.label)}) — zie de PDF in de bijlage.</p>
    <p><b>Aandachtspunten:</b></p>
    <ul>${punten.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>
    <p style="color:#999;font-size:12px;margin-top:22px;">Automatisch · Morrow.</p></div>`;

  if (DRY || !SMTP_PASS) { fs.writeFileSync(fname, pdf); console.log(`(DRY of geen SMTP_PASS) — PDF lokaal opgeslagen als ${fname}, geen mail.`); return; }
  await smtpSend({ from: MAIL_FROM, to: MAIL_TO, subject: `HubSpot sales-${kind}rapport — ${win.label}`, html: body, attachment: { filename: fname, buffer: Buffer.from(pdf) } });
  console.log(`Mail met bijlage verstuurd naar ${MAIL_TO}.`);
}
if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
module.exports = { window_, reportHtml, aandachtspunten };
