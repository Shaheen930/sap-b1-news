// SAP Business One news bot: fetches feeds, filters + summarises with a free
// OpenRouter model, and rebuilds index.html. Runs on GitHub Actions. No dependencies.
import { readFile, writeFile, mkdir } from "node:fs/promises";

const FEEDS = [
  { name: "Google News", url: "https://news.google.com/rss/search?q=%22SAP+Business+One%22+when:14d&hl=en-US&gl=US&ceid=US:en" },
  { name: "Google News", url: "https://news.google.com/rss/search?q=%22SAP+B1%22+when:14d&hl=en-US&gl=US&ceid=US:en" },
  { name: "SAP News Center", url: "https://news.sap.com/?s=%22business+one%22&feed=rss2" },
];
const MODEL = process.env.MODEL || "openrouter/free";
const KEY = process.env.OPENROUTER_API_KEY;
const DATA_FILE = "data/news.json";
const MAX_ITEMS = 300;
const CATEGORIES = ["Release", "Feature", "Cloud", "AI", "Support dates", "Customer story", "Partner", "Event", "Other"];

// ---------- feeds ----------
const decode = (s = "") =>
  s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'").replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d)).replace(/&nbsp;/g, " ").replace(/&amp;/g, "&");
const strip = (s = "") => decode(decode(s)).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
const tag = (xml, t) => { const m = xml.match(new RegExp(`<${t}[^>]*>([\\s\\S]*?)</${t}>`)); return m ? m[1] : ""; };
const normTitle = (t) => t.toLowerCase().replace(/\s+-\s+[^-]+$/, "").replace(/[^a-z0-9]+/g, " ").trim();

async function fetchFeed(feed) {
  try {
    const res = await fetch(feed.url, { headers: { "User-Agent": "Mozilla/5.0 (sap-b1-news-bot)" } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const xml = await res.text();
    return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map(([, it]) => {
      const title = strip(tag(it, "title"));
      const publisher = strip(tag(it, "source")) || feed.name;
      return {
        id: normTitle(title),
        // Google News appends " - Publisher" to every title; drop it.
        title: publisher !== feed.name ? title.replace(/\s+-\s+[^-]+$/, "") : title,
        link: strip(tag(it, "link")),
        date: new Date(strip(tag(it, "pubDate")) || Date.now()).toISOString(),
        snippet: strip(tag(it, "description")).slice(0, 400),
        publisher,
        feed: feed.name,
      };
    }).filter((i) => i.title && i.link);
  } catch (e) {
    console.warn(`Feed failed (${feed.url}): ${e.message}`);
    return [];
  }
}

// ---------- AI ----------
async function classify(candidates) {
  const list = candidates.map((c, n) => `[${n}] ${c.title}\nPublisher: ${c.publisher}\nSnippet: ${c.snippet}`).join("\n\n");
  const prompt = `You filter news for an SAP Business One (SAP B1) consultant.
For EACH numbered item decide if it is mainly about SAP Business One (the SME ERP from SAP):
versions, feature packs, release notes, HANA version, Web Client, Service Layer, SDK, add-ons,
cloud hosting, AI/Joule for B1, end of support dates, licensing, customer go-lives, partners, events.
Items that only mention B1 in passing, or are about other SAP products (S/4HANA etc.) are NOT relevant.
Use ONLY the title and snippet given. Never invent facts, versions or dates.

Reply with ONLY a JSON array, no markdown, one object per item:
[{"n":0,"relevant":true,"category":"one of ${CATEGORIES.join(" | ")}","summary":"1-2 factual sentences","why":"1 sentence: why it matters to an SAP B1 consultant"}]

ITEMS:
${list}`;

  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json", "X-Title": "SAP B1 News Bot" },
    body: JSON.stringify({ model: MODEL, temperature: 0.1, messages: [{ role: "user", content: prompt }] }),
  });
  if (!res.ok) throw new Error(`OpenRouter HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const text = (await res.json()).choices?.[0]?.message?.content || "";
  const json = text.slice(text.indexOf("["), text.lastIndexOf("]") + 1);
  return JSON.parse(json);
}

// Used only when the AI step fails: keep items whose title names the product.
const keywordMatch = (c) => /\bsap business one\b|\bsap b1\b/i.test(c.title);

// ---------- main ----------
async function main() {
  await mkdir("data", { recursive: true });
  let db = { items: [], seen: [], lastChecked: null, lastAiError: null };
  try { db = { ...db, ...JSON.parse(await readFile(DATA_FILE, "utf8")) }; } catch {}

  const seen = new Set(db.seen);
  const fetched = (await Promise.all(FEEDS.map(fetchFeed))).flat();
  const fresh = [];
  for (const it of fetched.sort((a, b) => b.date.localeCompare(a.date))) {
    if (seen.has(it.id) || fresh.some((f) => f.id === it.id)) continue;
    fresh.push(it);
  }
  const batch = fresh.slice(0, 30);
  console.log(`Fetched ${fetched.length}, new ${fresh.length}, processing ${batch.length}`);

  let added = [];
  if (batch.length) {
    let verdicts = null;
    if (KEY) {
      try { verdicts = await classify(batch); db.lastAiError = null; }
      catch (e) { console.warn(`AI step failed: ${e.message}`); db.lastAiError = e.message.slice(0, 200); }
    }
    if (verdicts) {
      for (const v of verdicts) {
        const c = batch[v.n];
        if (c && v.relevant) added.push({ ...c, category: CATEGORIES.includes(v.category) ? v.category : "Other", summary: v.summary || "", why: v.why || "", ai: true });
      }
      batch.forEach((c) => seen.add(c.id)); // every item the AI judged is done
    } else {
      // No AI this run: publish only obvious matches, leave the rest to retry next run.
      for (const c of batch.filter(keywordMatch)) {
        added.push({ ...c, category: "Other", summary: c.snippet.slice(0, 220), why: "", ai: false });
        seen.add(c.id);
      }
    }
  }

  db.items = [...added, ...db.items].sort((a, b) => b.date.localeCompare(a.date)).slice(0, MAX_ITEMS);
  db.seen = [...seen].slice(-3000);
  db.lastChecked = new Date().toISOString();
  await writeFile(DATA_FILE, JSON.stringify(db, null, 2));
  await writeFile("index.html", render(db));
  console.log(`Added ${added.length}. Total ${db.items.length}.`);
}

// ---------- page ----------
const esc = (s = "") => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmt = (iso) => new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });

function render(db) {
  const cats = [...new Set(db.items.map((i) => i.category))];
  const cards = db.items.map((i) => `
    <article class="card" data-cat="${esc(i.category)}" data-text="${esc((i.title + " " + i.summary).toLowerCase())}">
      <div class="meta"><span class="cat">${esc(i.category)}</span><time datetime="${i.date}">${fmt(i.date)}</time><span>${esc(i.publisher)}</span></div>
      <h2><a href="${esc(i.link)}" target="_blank" rel="noopener">${esc(i.title)}</a></h2>
      ${i.summary ? `<p>${esc(i.summary)}</p>` : ""}
      ${i.why ? `<p class="why"><b>Why it matters:</b> ${esc(i.why)}</p>` : ""}
    </article>`).join("");

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>SAP B1 Radar</title>
<meta name="description" content="Automatic SAP Business One news, updated every 6 hours.">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@500&display=swap" rel="stylesheet">
<style>
:root{--bg:#f4f6f9;--card:#fff;--fg:#14202e;--muted:#5a6878;--line:#dde3ea;--accent:#0a6ed1;--soft:#e6f0fb;color-scheme:light}
@media (prefers-color-scheme:dark){:root{--bg:#0d1520;--card:#142030;--fg:#e8eef5;--muted:#93a3b5;--line:#22324a;--accent:#4aa3f0;--soft:#16304d;color-scheme:dark}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.55 "IBM Plex Sans",system-ui,sans-serif}
.wrap{max-width:820px;margin:0 auto;padding:28px 16px 60px}
header h1{margin:0;font-size:28px;letter-spacing:-.01em}header h1 span{color:var(--accent)}
.sub{color:var(--muted);margin:6px 0 4px}.stamp{font:12px "IBM Plex Mono",monospace;color:var(--muted)}
.tools{display:flex;gap:8px;flex-wrap:wrap;margin:22px 0 16px}
input{flex:1 1 220px;padding:10px 12px;border:1px solid var(--line);border-radius:10px;background:var(--card);color:var(--fg);font:inherit}
button{padding:8px 12px;border:1px solid var(--line);border-radius:999px;background:var(--card);color:var(--fg);font:13px inherit;cursor:pointer}
button.on{background:var(--accent);border-color:var(--accent);color:#fff}
.list{display:flex;flex-direction:column;gap:12px}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:16px 18px}
.meta{display:flex;gap:10px;flex-wrap:wrap;font:12px "IBM Plex Mono",monospace;color:var(--muted)}
.cat{color:var(--accent)}
.card h2{font-size:17px;margin:8px 0 6px;line-height:1.35}.card h2 a{color:inherit;text-decoration:none}.card h2 a:hover{color:var(--accent)}
.card p{margin:0;color:var(--muted);font-size:14.5px}.card .why{margin-top:8px;color:var(--fg);background:var(--soft);padding:8px 11px;border-radius:9px;font-size:14px}
.empty{color:var(--muted);text-align:center;padding:40px 0}
footer{margin-top:30px;color:var(--muted);font-size:12.5px}
</style></head><body><div class="wrap">
<header>
  <h1>SAP <span>B1</span> Radar</h1>
  <p class="sub">SAP Business One news, collected and summarised automatically every 6 hours.</p>
  <div class="stamp">Last checked: ${new Date(db.lastChecked).toUTCString()} · ${db.items.length} stories</div>
</header>
<div class="tools">
  <input id="q" type="search" placeholder="Search news…" aria-label="Search news">
  <button class="on" data-f="all">All</button>${cats.map((c) => `<button data-f="${esc(c)}">${esc(c)}</button>`).join("")}
</div>
<div class="list" id="list">${cards || '<p class="empty">No SAP Business One stories yet. The first check runs within 6 hours.</p>'}</div>
<p class="empty" id="none" hidden>No stories match your search.</p>
<footer>Independent page, not an official SAP product. Summaries are machine-generated from public headlines; open the source before relying on any detail.</footer>
</div>
<script>
let f="all";const q=document.getElementById("q"),cards=[...document.querySelectorAll(".card")],none=document.getElementById("none");
function apply(){const t=q.value.toLowerCase().trim();let shown=0;cards.forEach(c=>{const ok=(f==="all"||c.dataset.cat===f)&&(!t||c.dataset.text.includes(t));c.hidden=!ok;if(ok)shown++});none.hidden=shown>0||!cards.length}
document.querySelectorAll("[data-f]").forEach(b=>b.onclick=()=>{f=b.dataset.f;document.querySelectorAll("[data-f]").forEach(x=>x.classList.toggle("on",x===b));apply()});
q.oninput=apply;
</script></body></html>`;
}

main().catch((e) => { console.error(e); process.exit(1); });
