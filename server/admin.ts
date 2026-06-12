// The admin surface for admin.handlingtheloop.com — a SEPARATE worker (full
// isolation from the public app) that binds the SAME D1 + R2. Gated by Cloudflare
// Access (verified per-request in access.ts). Privileged control: browse the
// community catalog, DMCA takedowns (drop the row + optionally purge the R2 bytes,
// always audit-logged), reindex, and an accounts overview.
import {
  type D1Database,
  listCommunityTracks,
  deleteCommunityTrack,
  countCommunityTracks,
  countAnalysis,
  listAnalysis,
  upsertCommunityTrack,
  logTakedown,
  listTakedowns,
  listUsers,
  deleteUser,
} from "./db";
import { type AccessEnv, verifyAccess } from "./access";

interface R2Listed {
  objects: { key: string; size: number; customMetadata?: Record<string, string> }[];
  truncated: boolean;
  cursor?: string;
}
interface AdminR2 {
  list(opts?: { prefix?: string; limit?: number; cursor?: string; include?: ("customMetadata")[] }): Promise<R2Listed>;
  delete(keys: string | string[]): Promise<void>;
}
export interface AdminEnv extends AccessEnv {
  DB: D1Database;
  AUDIO: AdminR2;
  HF_TOKEN?: string; // write-scoped HuggingFace token (admin secret)
  HF_DATASET?: string; // dataset repo id, defaults to asuramaya/htl-analysis
}
interface ExecutionContext {
  waitUntil(p: Promise<unknown>): void;
}

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const isVideoId = (v: unknown): v is string => typeof v === "string" && /^[\w-]{11}$/.test(v);

/** Delete every R2 object belonging to a track: audio, meta sidecar, all stem sets. */
async function purgeTrack(r2: AdminR2, v: string): Promise<number> {
  const keys: string[] = [`a/${v}`, `m/${v}`];
  let cursor: string | undefined;
  do {
    const page = await r2.list({ prefix: "s/", limit: 1000, cursor }); // s/<model>/<v>/<stem>
    for (const o of page.objects) if (o.key.includes(`/${v}/`)) keys.push(o.key);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  await r2.delete(keys);
  return keys.length;
}

/** Object count + byte total by storage class (audio / meta / stems). */
async function storageStats(r2: AdminR2): Promise<Record<string, { count: number; bytes: number }>> {
  const out = { audio: { count: 0, bytes: 0 }, meta: { count: 0, bytes: 0 }, stems: { count: 0, bytes: 0 } };
  const map: [string, keyof typeof out][] = [["a/", "audio"], ["m/", "meta"], ["s/", "stems"]];
  for (const [prefix, bucket] of map) {
    let cursor: string | undefined;
    do {
      const pg = await r2.list({ prefix, limit: 1000, cursor });
      for (const o of pg.objects) {
        out[bucket].count++;
        out[bucket].bytes += o.size || 0;
      }
      cursor = pg.truncated ? pg.cursor : undefined;
    } while (cursor);
  }
  return out;
}

// Base64 of a UTF-8 string (Workers' btoa is latin1-only).
function b64utf8(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

// Commit one or more small (non-LFS) files to an HF dataset repo via the Hub
// commit API (NDJSON: a header op + one file op per file, inline base64).
async function hfCommit(
  token: string,
  repo: string,
  files: { path: string; content: string }[],
  summary: string,
): Promise<void> {
  const lines = [JSON.stringify({ key: "header", value: { summary } })];
  for (const f of files) {
    lines.push(JSON.stringify({ key: "file", value: { content: b64utf8(f.content), path: f.path, encoding: "base64" } }));
  }
  const res = await fetch(`https://huggingface.co/api/datasets/${repo}/commit/main`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/x-ndjson" },
    body: lines.join("\n") + "\n",
  });
  if (!res.ok) throw new Error(`HF commit ${res.status}: ${(await res.text()).slice(0, 300)}`);
}

// Promote the D1 analysis layer to the public HF dataset (analysis.jsonl, one
// track per line — facts only, no audio). Manual trigger from the admin panel.
async function exportToHf(env: AdminEnv): Promise<{ exported: number; repo: string }> {
  if (!env.HF_TOKEN) throw new Error("HF_TOKEN not configured on htl-admin");
  const repo = env.HF_DATASET || "asuramaya/htl-analysis";
  const rows = [];
  for (let offset = 0; ; offset += 5000) {
    const page = await listAnalysis(env.DB, 5000, offset);
    rows.push(...page);
    if (page.length < 5000) break;
  }
  const jsonl =
    rows
      .map((r) =>
        JSON.stringify({
          video_id: r.video_id,
          bpm: r.bpm,
          key: r.music_key,
          key_name: r.key_name,
          beat_offset: r.beat_offset,
          duration: r.duration,
        }),
      )
      .join("\n") + "\n";
  const readme =
    `---\nlicense: cc0-1.0\ntags: [music-information-retrieval, audio, bpm, key-detection]\n---\n\n` +
    `# htl analysis\n\nCrowdsourced music-information features — BPM, musical key (Camelot), and beat-grid offset — ` +
    `keyed by YouTube video id. Derived features (facts about recordings), no audio. Generated by ` +
    `[Handling The Loop](https://handlingtheloop.com). ${rows.length} tracks.\n`;
  await hfCommit(env.HF_TOKEN, repo, [
    { path: "analysis.jsonl", content: jsonl },
    { path: "README.md", content: readme },
  ], `htl analysis export — ${rows.length} tracks`);
  return { exported: rows.length, repo };
}

async function reindexFromR2(env: AdminEnv): Promise<number> {
  const side = new Map<string, Record<string, string>>();
  let sc: string | undefined;
  do {
    const pg = await env.AUDIO.list({ prefix: "m/", limit: 1000, cursor: sc, include: ["customMetadata"] });
    for (const o of pg.objects) if (o.customMetadata?.title) side.set(o.key.slice(2), o.customMetadata);
    sc = pg.truncated ? pg.cursor : undefined;
  } while (sc);
  let indexed = 0;
  let cursor: string | undefined;
  do {
    const pg = await env.AUDIO.list({ prefix: "a/", limit: 1000, cursor, include: ["customMetadata"] });
    for (const o of pg.objects) {
      const v = o.key.slice(2);
      if (!isVideoId(v)) continue;
      const m = o.customMetadata?.title ? o.customMetadata : side.get(v);
      await upsertCommunityTrack(env.DB, {
        videoId: v,
        title: m?.title ?? "",
        artist: m?.artist ?? null,
        duration: Number(m?.duration) || 0,
        thumbnail: m?.thumbnail ?? null,
      });
      indexed++;
    }
    cursor = pg.truncated ? pg.cursor : undefined;
  } while (cursor);
  return indexed;
}

export async function handleAdmin(req: Request, env: AdminEnv, _ctx: ExecutionContext): Promise<Response> {
  const url = new URL(req.url);
  const p = url.pathname;

  // Gate EVERYTHING behind a verified Cloudflare Access identity.
  const auth = await verifyAccess(req, env);
  if (!auth.ok) return new Response(`Forbidden — ${auth.reason}`, { status: 403, headers: { "content-type": "text/plain" } });
  const admin = { email: auth.email };

  if (req.method === "GET" && p === "/") {
    return new Response(ADMIN_HTML, { headers: { "content-type": "text/html;charset=utf-8", "cache-control": "no-store" } });
  }
  if (!env.DB) return json(500, { error: "D1 not bound" });

  if (req.method === "GET" && p === "/api/stats") {
    const tracks = await countCommunityTracks(env.DB);
    const analyzed = await countAnalysis(env.DB);
    const last = (await listTakedowns(env.DB, 1))[0];
    return json(200, { admin: admin.email, tracks, analyzed, lastTakedownTs: last?.ts ?? null });
  }
  if (req.method === "GET" && p === "/api/community") {
    const limit = Math.min(Number(url.searchParams.get("limit")) || 200, 500);
    const q = (url.searchParams.get("q") || "").toLowerCase().trim();
    let rows = await listCommunityTracks(env.DB, limit);
    if (q) rows = rows.filter((t) => `${t.title} ${t.artist} ${t.videoId}`.toLowerCase().includes(q));
    return json(200, { tracks: rows });
  }
  if (req.method === "GET" && p === "/api/takedowns") {
    return json(200, { takedowns: await listTakedowns(env.DB, 200) });
  }
  if (req.method === "GET" && p === "/api/users") {
    return json(200, { users: await listUsers(env.DB, 500) });
  }
  if (req.method === "POST" && p === "/api/takedown") {
    const b = (await req.json().catch(() => ({}))) as { videoId?: string; reason?: string; purge?: boolean };
    if (!isVideoId(b.videoId)) return json(400, { error: "bad videoId" });
    await deleteCommunityTrack(env.DB, b.videoId);
    const purgedObjects = b.purge ? await purgeTrack(env.AUDIO, b.videoId) : 0;
    await logTakedown(env.DB, { videoId: b.videoId, reason: b.reason ?? null, byEmail: admin.email, purged: !!b.purge });
    return json(200, { ok: true, purgedObjects });
  }
  if (req.method === "POST" && p === "/api/reindex") {
    return json(200, { indexed: await reindexFromR2(env) });
  }
  if (req.method === "POST" && p === "/api/export") {
    try {
      return json(200, await exportToHf(env));
    } catch (e) {
      return json(502, { error: (e as Error).message });
    }
  }
  if (req.method === "GET" && p === "/api/storage") {
    return json(200, await storageStats(env.AUDIO));
  }
  if (req.method === "POST" && p === "/api/user/delete") {
    const b = (await req.json().catch(() => ({}))) as { userId?: string };
    if (!b.userId) return json(400, { error: "missing userId" });
    await deleteUser(env.DB, b.userId);
    return json(200, { ok: true });
  }
  return json(404, { error: "not found" });
}

// Self-contained admin page (no build, no bundle). Vanilla JS over the JSON API.
// Served under a strict CSP: the inline <script> runs only via a per-request nonce
// and there are no inline event handlers, so script-src needs no 'unsafe-inline'.
const adminHtml = (nonce: string): string => `<!doctype html><html lang=en><head><meta charset=utf-8>
<meta name=viewport content="width=device-width,initial-scale=1"><title>htl admin</title>
<style>
:root{--bg:#0b0b10;--panel:#15151f;--line:#26263a;--text:#e8e8f2;--muted:#9a9ab0;--accent:#6ee7a8;--danger:#ff6b6b}
*{box-sizing:border-box}body{margin:0;font:14px/1.5 system-ui,sans-serif;background:var(--bg);color:var(--text)}
header{display:flex;align-items:center;gap:14px;padding:12px 18px;border-bottom:1px solid var(--line);background:var(--panel)}
header b{font-size:15px}.who{margin-left:auto;color:var(--muted);font-size:12px}
.tabs{display:flex;gap:2px;padding:0 12px;border-bottom:1px solid var(--line);background:var(--panel)}
.tabs button{background:none;border:none;color:var(--muted);padding:10px 14px;cursor:pointer;font:inherit;border-bottom:2px solid transparent}
.tabs button.on{color:var(--text);border-bottom-color:var(--accent)}
main{padding:16px 18px;max-width:1100px}
.bar{display:flex;gap:10px;align-items:center;margin-bottom:12px}
input,button.act{font:inherit}input{background:#0d0d14;border:1px solid var(--line);color:var(--text);padding:7px 10px;border-radius:7px}
.stat{display:inline-block;margin-right:18px;color:var(--muted)}.stat b{color:var(--text)}
table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:7px 8px;border-bottom:1px solid var(--line);font-size:13px;vertical-align:middle}
th{color:var(--muted);font-weight:600}img{width:48px;height:28px;object-fit:cover;border-radius:3px}
.id{color:var(--muted);font-family:ui-monospace,monospace;font-size:11px}
button.act{border:1px solid var(--line);background:#1b1b27;color:var(--text);padding:5px 9px;border-radius:6px;cursor:pointer;font-size:12px}
button.danger{border-color:#5a2630;color:var(--danger)}button.act:hover{background:#23233200}
.hide{display:none}.muted{color:var(--muted)}
</style></head><body>
<header><b>htl admin</b><span class=muted>handlingtheloop.com</span><span class=who id=who></span></header>
<div class=tabs>
  <button class=on data-t=community>Community</button>
  <button data-t=takedowns>Takedowns</button>
  <button data-t=users>Accounts</button>
</div>
<main>
  <div id=stats class=bar></div>
  <section id=community>
    <div class=bar>
      <input id=dmca placeholder="DMCA — paste a YouTube URL or video id to take down" style=flex:1>
      <button class="act danger" id=dmcabtn>Takedown + purge</button>
    </div>
    <div class=bar>
      <input id=q placeholder="search title / artist / id" style=flex:1>
      <button class=act id=storagebtn>Storage usage</button>
      <button class=act id=reindex>Reindex from R2</button>
      <button class=act id=export>Export → HF</button>
    </div>
    <div id=storageout class=muted style=margin-bottom:10px></div>
    <table><thead><tr><th></th><th>Title</th><th>Artist</th><th>Video id</th><th></th></tr></thead><tbody id=ctbody></tbody></table>
  </section>
  <section id=takedowns class=hide><table><thead><tr><th>When</th><th>Video id</th><th>Reason</th><th>By</th><th>Purged</th></tr></thead><tbody id=ttbody></tbody></table></section>
  <section id=users class=hide><table><thead><tr><th>Email</th><th>Name</th><th>Services</th><th>Last login</th><th></th></tr></thead><tbody id=utbody></tbody></table></section>
</main>
<script>
const $=s=>document.querySelector(s), api=(p,o)=>fetch(p,o).then(r=>r.json());
const fmt=t=>t?new Date(t).toLocaleString():'—';
// DOM builders — every value enters via textContent (never innerHTML) and actions
// bind via addEventListener (no inline onclick), so attacker-controlled catalog /
// account data can't inject markup or script into this privileged page.
function clear(n){while(n.firstChild)n.removeChild(n.firstChild);}
function cell(text,cls){const td=document.createElement('td');if(cls)td.className=cls;td.textContent=text==null?'':String(text);return td;}
function btn(label,cls,on){const b=document.createElement('button');b.className=cls;b.textContent=label;b.addEventListener('click',on);return b;}
function emptyRow(msg){const tr=document.createElement('tr');const td=cell(msg,'muted');td.colSpan=5;tr.appendChild(td);return tr;}
function safeUrl(u){try{const x=new URL(u);return(x.protocol==='http:'||x.protocol==='https:')?u:null;}catch(e){return null;}}
async function stats(){const s=await api('/api/stats');$('#who').textContent=s.admin;const w=$('#stats');clear(w);
  const mk=(label,val)=>{const sp=document.createElement('span');sp.className='stat';sp.appendChild(document.createTextNode(label+' '));const b=document.createElement('b');b.textContent=val;sp.appendChild(b);return sp;};
  w.appendChild(mk('Tracks',s.tracks));w.appendChild(mk('Analyzed',s.analyzed));w.appendChild(mk('Last takedown',fmt(s.lastTakedownTs)));}
async function takedown(v,purge){const reason=prompt((purge?'PURGE + ':'')+'Takedown reason for '+v+' (DMCA / note):','');if(reason===null)return;
  const r=await api('/api/takedown',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({videoId:v,reason,purge})});
  if(r.ok){alert('Removed'+(purge?(' + purged '+r.purgedObjects+' R2 objects'):''));loadCommunity();stats();}else alert('Failed: '+(r.error||''));}
async function loadCommunity(){const q=$('#q').value.trim();const {tracks}=await api('/api/community?limit=500'+(q?'&q='+encodeURIComponent(q):''));
  const tb=$('#ctbody');clear(tb);if(!tracks.length){tb.appendChild(emptyRow('No tracks.'));return;}
  for(const t of tracks){const tr=document.createElement('tr');
    const tdi=document.createElement('td');const src=safeUrl(t.thumbnail);if(src){const img=document.createElement('img');img.src=src;tdi.appendChild(img);}tr.appendChild(tdi);
    tr.appendChild(cell(t.title||'—'));tr.appendChild(cell(t.artist||''));tr.appendChild(cell(t.videoId,'id'));
    const tda=document.createElement('td');tda.style.whiteSpace='nowrap';
    tda.appendChild(btn('Remove','act',()=>takedown(t.videoId,false)));tda.appendChild(document.createTextNode(' '));
    tda.appendChild(btn('Remove + purge','act danger',()=>takedown(t.videoId,true)));tr.appendChild(tda);tb.appendChild(tr);}}
async function loadTakedowns(){const {takedowns}=await api('/api/takedowns');const tb=$('#ttbody');clear(tb);
  if(!takedowns.length){tb.appendChild(emptyRow('None.'));return;}
  for(const t of takedowns){const tr=document.createElement('tr');tr.appendChild(cell(fmt(t.ts)));tr.appendChild(cell(t.video_id,'id'));tr.appendChild(cell(t.reason||''));tr.appendChild(cell(t.by_email,'muted'));tr.appendChild(cell(t.purged?'yes':'no'));tb.appendChild(tr);}}
async function loadUsers(){const {users}=await api('/api/users');const tb=$('#utbody');clear(tb);
  if(!users.length){tb.appendChild(emptyRow('No accounts.'));return;}
  for(const u of users){const tr=document.createElement('tr');tr.appendChild(cell(u.email||'—'));tr.appendChild(cell(u.name||''));tr.appendChild(cell(u.providers||'','muted'));tr.appendChild(cell(fmt(u.last_login),'muted'));
    const tda=document.createElement('td');tda.appendChild(btn('Delete','act danger',()=>delUser(u.id,u.email||u.id)));tr.appendChild(tda);tb.appendChild(tr);}}
async function delUser(id,label){if(!confirm('Delete account '+label+'? Removes their sessions, connections and syncs. Cannot be undone.'))return;const r=await api('/api/user/delete',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({userId:id})});if(r.ok){alert('Deleted');loadUsers();}else alert('Failed: '+(r.error||''));}
function parseId(s){s=(s||'').trim();if(/^[\\w-]{11}$/.test(s))return s;try{const u=new URL(s);if(u.hostname==='youtu.be')return u.pathname.slice(1,12);const v=u.searchParams.get('v');if(v)return v;const m=u.pathname.match(/\\/(?:shorts|embed|v|live)\\/([\\w-]{11})/);if(m)return m[1];}catch(e){}return null;}
const fmtMB=b=>(b/1048576).toFixed(1)+' MB';
async function loadStorage(){$('#storageout').textContent='Loading…';const s=await api('/api/storage');const tot=s.audio.bytes+s.meta.bytes+s.stems.bytes;
  $('#storageout').innerHTML='R2: <b>'+fmtMB(tot)+'</b> total — audio '+s.audio.count+' ('+fmtMB(s.audio.bytes)+'), stems '+s.stems.count+' ('+fmtMB(s.stems.bytes)+'), meta '+s.meta.count;}
document.querySelectorAll('.tabs button').forEach(b=>b.onclick=()=>{document.querySelectorAll('.tabs button').forEach(x=>x.classList.toggle('on',x===b));
  ['community','takedowns','users'].forEach(s=>$('#'+s).classList.toggle('hide',s!==b.dataset.t));
  if(b.dataset.t==='takedowns')loadTakedowns();if(b.dataset.t==='users')loadUsers();});
$('#q').oninput=()=>{clearTimeout(window._t);window._t=setTimeout(loadCommunity,250);};
$('#reindex').onclick=async()=>{$('#reindex').textContent='Reindexing…';const r=await api('/api/reindex',{method:'POST'});$('#reindex').textContent='Reindex from R2';alert('Indexed '+r.indexed+' tracks');loadCommunity();stats();};
$('#storagebtn').onclick=loadStorage;
$('#export').onclick=async()=>{$('#export').textContent='Exporting…';const r=await api('/api/export',{method:'POST'});$('#export').textContent='Export → HF';if(r.exported!=null)alert('Exported '+r.exported+' tracks → huggingface.co/datasets/'+r.repo);else alert('Export failed: '+(r.error||''));};
$('#dmcabtn').onclick=()=>{const id=parseId($('#dmca').value);if(!id){alert('Could not find an 11-char video id in that input.');return;}takedown(id,true);$('#dmca').value='';};
$('#dmca').addEventListener('keydown',e=>{if(e.key==='Enter')$('#dmcabtn').click();});
stats();loadCommunity();
</script></body></html>`;
