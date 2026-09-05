'use strict';
// Research instruments. Additive to casefile's log tools: these do not touch the
// log, they reach sources. Dependency-free - Node 20+ global fetch only.
const { db } = require('./db');

// Not a general web proxy. Only repositories this investigation actually uses.
const ALLOWED = [
  'anno.onb.ac.at', 'digital.onb.ac.at', 'iiif.onb.ac.at', 'data.onb.ac.at',
  'adt.arcanum.com', 'hungaricana.hu', 'library.hungaricana.hu',
  'archives.hungaricana.hu', 'maps.hungaricana.hu', 'eleveltar.hu',
  'archives.milev.hu', 'collections.milev.hu', 'collections.ushmm.org',
  'ushmm.org', 'epa.oszk.hu', 'medit.lutheran.hu',
  'database.budapestjewishcemetery.com', 'adatbazisokonline.mnl.gov.hu',
  'familysearch.org', 'arolsen-archives.org', 'yvng.yadvashem.org',
  'digital.wienbibliothek.at', 'landesarchiv-burgenland.at', 'wien.gv.at',
  'ikg-wien.at'
];

// Every repository the log has recorded as "closed to agents, open to a browser",
// plus the ones known to work, so a session can tell in one call which queue
// items are actually executable from here.
const PROBES = [
  ['ANNO search',                         'https://anno.onb.ac.at/anno-suche'],
  ['ONB digital (IIIF page images)',      'https://digital.onb.ac.at/'],
  ['ADT Arcanum - Budapesti Kozlony',     'https://adt.arcanum.com/hu/collection/BudapestiKozlony/'],
  ['Hungaricana library',                 'https://library.hungaricana.hu/hu/'],
  ['Hungaricana archives',                'https://archives.hungaricana.hu/hu/'],
  ['eleveltar.hu',                        'https://eleveltar.hu/'],
  ['MILEV AtoM (Chevra Kadisa)',          'https://archives.milev.hu/index.php/chevra-kadisa-11;isad'],
  ['USHMM collections search',            'https://collections.ushmm.org/search/'],
  ['Kozma utca burial index',             'https://database.budapestjewishcemetery.com/'],
  ['MNL AdatbazisokOnline',               'https://adatbazisokonline.mnl.gov.hu/'],
  ['EPA OSZK',                            'https://epa.oszk.hu/'],
  ['medit.lutheran.hu (school annuals)',  'https://medit.lutheran.hu/'],
  ['FamilySearch',                        'https://www.familysearch.org/search/'],
  ['Wienbibliothek digital (Lehmann)',    'https://digital.wienbibliothek.at/']
];

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
           '(KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

// A case may widen the allowlist for itself. The built-in list is entirely
// Central European because that is where this investigation started; a case
// about someone who emigrated needs American or other repositories, and
// hard-coding every case's sources into one global list makes it meaningless.
// Widening is per case, recorded with who did it, and named in the reachability
// output - visible, never silent.
const caseHosts = slug => {
  if (!slug) return [];
  try {
    return db.prepare(`SELECT host, probe_url, note, added_by FROM case_sources
      WHERE case_slug=? ORDER BY host`).all(slug);
  } catch { return []; }
};

function hostAllowed(u, slug) {
  let h;
  try { h = new URL(u).hostname.toLowerCase(); } catch { return false; }
  const list = ALLOWED.concat(caseHosts(slug).map(r => r.host));
  return list.some(a => h === a || h.endsWith('.' + a));
}

async function get(url, timeoutMs) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs || 15000);
  const started = Date.now();
  try {
    const res = await fetch(url, {
      redirect: 'follow', signal: ctl.signal,
      headers: {
        'User-Agent': UA,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'hu-HU,hu;q=0.9,en;q=0.8'
      }
    });
    const body = await res.text().catch(() => '');
    clearTimeout(t);
    return { status: res.status, ok: res.ok, ms: Date.now() - started,
             type: res.headers.get('content-type') || '', body };
  } catch (e) {
    clearTimeout(t);
    return { status: 0, ok: false, ms: Date.now() - started,
             error: String((e && e.message) || e), body: '' };
  }
}

function toText(html, limit) {
  let s = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/[ \t ]+/g, ' ')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .trim();
  const lim = limit || 20000;
  if (s.length > lim) s = s.slice(0, lim) + '\n\n[TRUNCATED at ' + lim + ' characters]';
  return s;
}

async function reachability(a) {
  const slug = (a && a.case) || null;
  const extra = caseHosts(slug).map(r => ({
    name: (r.note ? r.note + ' (' + r.host + ')' : r.host) +
          '  [case source' + (r.added_by ? ', added by ' + r.added_by : '') + ']',
    url: r.probe_url || 'https://' + r.host + '/'
  }));
  const probes = PROBES.map(([name, url]) => ({ name, url })).concat(extra);
  const rows = await Promise.all(probes.map(async ({ name, url }) => {
    const r = await get(url, 15000);
    return { name, url, r };
  }));
  const verdict = r => r.status === 200 ? 'OPEN'
    : r.status === 0 ? 'NO CONNECTION'
    : r.status === 403 ? '403 BLOCKED' : String(r.status);
  const open = rows.filter(x => x.r.status === 200).map(x => x.name);
  return 'REACHABILITY FROM THIS SERVER (not from your own browsing tool)' +
    (slug
      ? ', including the ' + extra.length + ' host(s) case "' + slug + '" has added'
      : ' - pass case:"<slug>" to include that case\'s own added sources') +
    ':\n\n' +
    rows.map(x =>
      verdict(x.r).padEnd(14) + String(x.r.ms + 'ms').padEnd(8) + x.name +
      '\n' + ' '.repeat(22) + x.url +
      (x.r.error ? '\n' + ' '.repeat(22) + 'error: ' + x.r.error : '')
    ).join('\n') +
    '\n\nOPEN HERE: ' + (open.length ? open.join('; ') : 'none') +
    '\n\nA 403 or a timeout is an ACCESS FACT, never evidence about the subject. ' +
    'Record it as "not searched, blocked" - never as "searched, nothing found".';
}

async function fetchSource(a) {
  const url = a.url;
  if (!hostAllowed(url, a.case)) {
    const extra = caseHosts(a.case).map(r => r.host);
    return 'REFUSED: ' + url + ' is not on the allowlist. This is not a general web proxy.\n' +
      'Allowed hosts: ' + ALLOWED.join(', ') +
      (extra.length ? '\nPlus this case\'s own: ' + extra.join(', ') : '') +
      (a.case
        ? '\n\nIf this case genuinely needs that repository, add it with casefile_source_add ' +
          '{ case: "' + a.case + '", host: "<hostname>", note: "<what it is>" } and fetch again.'
        : '\n\nNOTE: you did not pass a case. A case can widen the allowlist for itself - ' +
          'call again with case:"<slug>", and add the host with casefile_source_add if it is missing.');
  }
  const r = await get(url, 25000);
  if (!r.ok) {
    return 'NOT FETCHED - this is an ACCESS RESULT, not a null result.\n' +
      'URL: ' + url + '\nHTTP: ' + (r.status || 'no connection') +
      (r.error ? '\nerror: ' + r.error : '') +
      '\n\nRecord it as blocked / not searched. Do NOT record it as searched-and-empty, ' +
      'and do NOT let it become a negative finding in the log.';
  }
  const body = a.mode === 'html' ? r.body.slice(0, a.limit || 20000) : toText(r.body, a.limit);
  return 'FETCHED ' + url + '\nHTTP ' + r.status + ' | ' + r.type + ' | ' +
    r.body.length + ' bytes | ' + r.ms + 'ms\n' +
    'REMINDER: read Hungarian sources in Hungarian. Hungaricana\'s English interface ' +
    'machine-translates the OCR and renders the surname Süsz as "GRILLED" or "roast", ' +
    'destroying the evidence in the snippet.\n\n' + body;
}

// ANNO/ANNOP hash reuse: the IIIF access hash is PER VOLUME, not per image, so one
// search hit anywhere in a volume opens every page of it.
function annoPage(a) {
  const m = /^([A-Za-z]+)(\d{4})(\d*)$/.exec(String(a.volume || ''));
  if (!m) throw new Error("volume must look like 'bbw19100004' - letters then digits.");
  const title = m[1], year = m[2], rest = m[3];
  const n = String(a.image).padStart(8, '0');
  const img = 'cont01periodika' + title + year + year + rest + '_' + n + '.jpg';
  const region = a.region || 'pct:0,0,100,8';
  const width = a.width || 1200;
  const url = 'https://digital.onb.ac.at/rep/access/ANNOP_' + a.volume + '/image/' + img +
    '?hash=' + a.hash + '&iiif=/ANNOP_' + a.volume + '/' + img + '/' + region + '/' + width + ',/0/default.jpg';
  return 'PAGE IMAGE URL:\n' + url + '\n\n' +
    'REGIONS: pct:0,0,100,8 = running head (binary-search the volume by its alphabetical ' +
    'guide words, one call per probe). pct:2,6,48,34 = left column. pct:46,6,50,34 = right ' +
    'column. A full column needs two crops of ~34% height at width 1500 to stay legible.\n\n' +
    'CAUTION: the printed page number usually equals the image number in these volumes, but ' +
    'not always - read the running head on every probe. If this URL 404s, copy the exact image ' +
    'name from a real search hit in the same volume and change only its number.\n\n' +
    'This returns a URL, not a transcription. If you cannot see images, hand the URL to an ' +
    'agent that can, or to Ted. Do not guess the contents from OCR.';
}

function identityCheck(a) {
  const c = a.case;
  const cand = a.candidate || {};
  const blob = Object.values(cand).join(' ').toLowerCase();
  const anchors = db.prepare(
    'SELECT * FROM persons WHERE case_slug=? ORDER BY status, display_name'
  ).all(c);
  const excluded = anchors.filter(p => p.status === 'excluded');
  const family = anchors.filter(p => p.status === 'family');

  const hits = [];
  for (const p of excluded) {
    const names = [p.display_name].concat(String(p.aka || '').split(/[;,]/))
      .map(s => s.trim().toLowerCase()).filter(Boolean);
    for (const nm of names) {
      const distinctive = nm.split(/\s+/).filter(w => w.length > 3);
      if (distinctive.length && distinctive.every(w => blob.includes(w))) {
        hits.push(p); break;
      }
    }
  }

  let out = 'CANDIDATE AS GIVEN:\n' +
    Object.entries(cand).map(([k, v]) => '  ' + k + ': ' + v).join('\n') + '\n\n';

  if (hits.length) {
    out += '*** MATCHES AN ALREADY-EXCLUDED PERSON. DO NOT REOPEN. ***\n' +
      hits.map(p => '  ' + p.display_name + ' (' + [p.born, p.died].filter(Boolean).join('-') +
        ')' + (p.notes ? '\n      ' + p.notes : '')).join('\n') + '\n\n';
  }

  out += 'REGISTERED FAMILY - the anchors any candidate must be tested against:\n' +
    (family.length
      ? family.map(p => '  ' + p.display_name + ' | ' + (p.relation || '') + ' | ' +
          [p.born, p.died].filter(Boolean).join('-') +
          (p.aka ? ' | aka ' + p.aka : '')).join('\n')
      : '  (none registered yet - register them with casefile_person)') + '\n\n';

  out += 'EXCLUDED SAME-NAME ROSTER (' + excluded.length + ' people). Never merge on a name match:\n' +
    (excluded.length ? excluded.map(p => '  ' + p.display_name +
      (p.notes ? ' - ' + String(p.notes).slice(0, 120) : '')).join('\n') : '  (none registered yet)');

  out += '\n\nCLASSIFY EXPLICITLY: VERIFIED (matches multiple primary anchors) / STRONG LEAD ' +
    '(plausible, one key element missing) / CANDIDATE (possible, evidence insufficient) / ' +
    'DISPROVEN (conflicts with a decisive anchor). A name plus a date is not an identification.';
  return out;
}

const str = description => ({ type: 'string', description });

const TOOLS = [
  { name: 'source_reachability',
    description: 'Probe every repository this investigation uses and report the real HTTP status from THIS server. Run it once per session: a source that is 403 to one agent is often open to another, and several queue items are blocked only by access. Pass a case slug to include the extra sources that case has added.',
    inputSchema: { type: 'object', properties: {
      case: str('case slug — also probe the hosts this case has added for itself')
    }, required: [] } },
  { name: 'source_fetch',
    description: 'Fetch a page from one of the investigation\'s repositories through this server and return its text. Use it when your own browsing is blocked. Allowlisted hosts only — the built-in list plus whatever the case named in `case` has added. A failure is reported as an access result, never as an empty search.',
    inputSchema: { type: 'object', properties: {
      url: str('full URL; host must be allowlisted'),
      case: str('case slug — required when the host is one this case added rather than a built-in'),
      mode: str("'text' (default, strips markup) or 'html'"),
      limit: { type: 'number', description: 'max characters, default 20000' }
    }, required: ['url'] } },
  { name: 'anno_page',
    description: 'Build a direct ANNO/ANNOP page-image URL by hash reuse - the IIIF access hash is per VOLUME, not per image, so one search hit opens every page of that volume. Navigate by running head.',
    inputSchema: { type: 'object', properties: {
      volume: str('ANNOP volume id, e.g. bbw19100004'),
      hash: str('the hash= value from any search hit inside that same volume'),
      image: { type: 'number', description: 'image number' },
      region: str('IIIF region; default pct:0,0,100,8 (running head)'),
      width: { type: 'number', description: 'output width px; 1500 for column reads' }
    }, required: ['volume', 'hash', 'image'] } },
  { name: 'identity_check',
    description: 'Test a candidate record against the case\'s registered family anchors and its excluded same-name roster BEFORE opening it. Prevents merging a record on a name match.',
    inputSchema: { type: 'object', properties: {
      case: str('case slug'),
      candidate: { type: 'object', description: 'what the record actually says: name, dates, places, occupation, address, parents' }
    }, required: ['case', 'candidate'] } }
];

async function call(name, a) {
  a = a || {};
  switch (name) {
    case 'source_reachability': return await reachability(a);
    case 'source_fetch':        return await fetchSource(a);
    case 'anno_page':           return annoPage(a);
    case 'identity_check':      return identityCheck(a);
    default: return null;
  }
}

module.exports = { TOOLS, call, hostAllowed, ALLOWED, PROBES, caseHosts };
