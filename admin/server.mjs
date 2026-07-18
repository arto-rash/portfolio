// Local admin for the portfolio — run `npm run admin` alongside `npm run dev`.
// Edits src/data/music.json, src/data/profile.json and src/content/blog/*.mdx
// directly on disk; astro dev hot-reloads them. Binds to localhost only.
// This never ships with the site — deploying is still `git commit && git push`.
import { createServer } from "node:http";
import { readFile, writeFile, readdir, mkdir, unlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BLOG_DIR = path.join(ROOT, "src", "content", "blog");
const MUSIC = path.join(ROOT, "src", "data", "music.json");
const PROFILE = path.join(ROOT, "src", "data", "profile.json");
const PORT = 4400;

const readJson = async (f) => JSON.parse(await readFile(f, "utf8"));
const today = () => new Date().toISOString().slice(0, 10);
const okSlug = (s) => /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(s);

function parseFrontmatter(src) {
  const m = src.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return { data: {}, body: src };
  const data = {};
  for (const line of m[1].split(/\r?\n/)) {
    const i = line.indexOf(":");
    if (i < 0) continue;
    const key = line.slice(0, i).trim();
    let v = line.slice(i + 1).trim();
    if (v.startsWith("[")) {
      try { data[key] = JSON.parse(v.replace(/'/g, '"')); } catch { data[key] = []; }
      continue;
    }
    if (v === "true" || v === "false") { data[key] = v === "true"; continue; }
    if (/^".*"$/.test(v)) { try { v = JSON.parse(v); } catch { v = v.slice(1, -1); } }
    else if (/^'.*'$/.test(v)) v = v.slice(1, -1);
    data[key] = v;
  }
  return { data, body: src.slice(m[0].length) };
}

// JSON.stringify output is valid YAML, so frontmatter strings are written as JSON strings
function serializePost({ title, date, excerpt, tags, draft, body }) {
  const fm = [
    "---",
    `title: ${JSON.stringify(title)}`,
    `date: ${date}`,
    `excerpt: ${JSON.stringify(excerpt)}`,
    `tags: ${JSON.stringify(tags)}`,
    ...(draft ? ["draft: true"] : []),
    "---",
    "",
  ].join("\n");
  return fm + String(body ?? "").trim() + "\n";
}

async function listPosts() {
  await mkdir(BLOG_DIR, { recursive: true });
  const files = (await readdir(BLOG_DIR)).filter((f) => /\.(md|mdx)$/.test(f));
  const posts = [];
  for (const f of files) {
    const { data } = parseFrontmatter(await readFile(path.join(BLOG_DIR, f), "utf8"));
    posts.push({
      slug: f.replace(/\.(md|mdx)$/, ""),
      title: data.title ?? f,
      date: data.date ?? "",
      draft: !!data.draft,
    });
  }
  posts.sort((a, b) => (a.date < b.date ? 1 : -1));
  return posts;
}

async function removePost(slug) {
  for (const ext of ["mdx", "md"]) {
    try { await unlink(path.join(BLOG_DIR, `${slug}.${ext}`)); } catch {}
  }
}

async function readBody(req) {
  let b = "";
  for await (const c of req) b += c;
  return b ? JSON.parse(b) : {};
}

function send(res, code, data, type = "application/json") {
  res.writeHead(code, { "content-type": `${type}; charset=utf-8` });
  res.end(type === "application/json" ? JSON.stringify(data) : data);
}

// ---- Mock of the Google Apps Script Web App (read + write), for local testing ----
const MOCK_TOKEN = "test";
let MOCK = {
  settings: {
    available: true,
    availableFor: "interesting problems",
    songTitle: "Chameleon",
    songArtist: "Herbie Hancock",
    songNote: "the pocket",
    songUrl: "https://youtu.be/nk8fXNBUZ0Y",
  },
  posts: [
    {
      slug: "hello-from-the-sheet",
      title: "Hello from the sheet",
      date: "2026-07-18",
      excerpt: "This post is served live from Google Sheets — no redeploy.",
      tags: "meta, astro",
      draft: false,
      body: "# It works\n\nThis whole post lives in a **spreadsheet cell**.\n\n- Edit the sheet\n- Refresh\n- Done\n\n> No rebuild required.\n\n```js\nconsole.log('rendered client-side')\n```",
    },
  ],
  experience: [
    { _row: 2, role: "Full-stack Web Developer", company: "Megasec LLC", location: "Baku", start: "2025-06", end: "", current: true, description: "" },
    { _row: 3, role: "Software Engineer", company: "Freelance", location: "Remote", start: "2023-12", end: "", current: true, description: "" },
  ],
  projects: [
    { slug: "mock-project", title: "Mock Project", tagline: "A project served live from the sheet.", role: "full-stack", status: "live", stack: "Astro, TypeScript", url: "https://example.com", image: "", description: "Short.", longDescription: "A longer description rendered client-side on the /work detail page.", accent: "#e02d00", featured: true },
  ],
};

function nextRow(list) {
  return Math.max(1, ...list.map((e) => e._row || 0)) + 1;
}

function mockRespond(res, obj) {
  res.writeHead(200, {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "*",
  });
  res.end(JSON.stringify(obj));
}

createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://localhost");
    const route = `${req.method} ${url.pathname}`;

    if (route === "GET /") return send(res, 200, PAGE, "text/html");

    if (route === "GET /api/state") {
      const music = await readJson(MUSIC);
      const profile = await readJson(PROFILE);
      return send(res, 200, {
        songOfTheDay: music.songOfTheDay,
        available: profile.available,
        availableFor: profile.availableFor,
        posts: await listPosts(),
      });
    }

    if (route === "GET /api/post") {
      const slug = url.searchParams.get("slug") ?? "";
      if (!okSlug(slug)) return send(res, 400, { error: "bad slug" });
      for (const ext of ["mdx", "md"]) {
        try {
          const src = await readFile(path.join(BLOG_DIR, `${slug}.${ext}`), "utf8");
          const { data, body } = parseFrontmatter(src);
          return send(res, 200, { slug, ...data, tags: data.tags ?? [], body });
        } catch {}
      }
      return send(res, 404, { error: "not found" });
    }

    if (route === "POST /api/music") {
      const b = await readBody(req);
      if (!b.title?.trim() || !b.artist?.trim()) return send(res, 400, { error: "title and artist are required" });
      const music = await readJson(MUSIC);
      music.songOfTheDay = {
        title: b.title.trim(),
        artist: b.artist.trim(),
        note: (b.note ?? "").trim(),
        url: (b.url ?? "").trim(),
        updated: today(),
      };
      await writeFile(MUSIC, JSON.stringify(music, null, 2) + "\n");
      return send(res, 200, { ok: true });
    }

    if (route === "POST /api/availability") {
      const b = await readBody(req);
      const profile = await readJson(PROFILE);
      profile.available = !!b.available;
      if (typeof b.availableFor === "string" && b.availableFor.trim()) {
        profile.availableFor = b.availableFor.trim();
      }
      await writeFile(PROFILE, JSON.stringify(profile, null, 2) + "\n");
      return send(res, 200, { ok: true });
    }

    if (route === "POST /api/post") {
      const b = await readBody(req);
      const slug = String(b.slug ?? "");
      if (!okSlug(slug)) return send(res, 400, { error: "slug must be lowercase letters, numbers and dashes" });
      if (!b.title?.trim() || !b.date) return send(res, 400, { error: "title and date are required" });
      await mkdir(BLOG_DIR, { recursive: true });
      // renamed? remove the old files; also remove a same-slug .md so routes can't duplicate
      if (b.originalSlug && okSlug(b.originalSlug) && b.originalSlug !== slug) await removePost(b.originalSlug);
      try { await unlink(path.join(BLOG_DIR, `${slug}.md`)); } catch {}
      await writeFile(
        path.join(BLOG_DIR, `${slug}.mdx`),
        serializePost({
          title: b.title.trim(),
          date: b.date,
          excerpt: (b.excerpt ?? "").trim(),
          tags: Array.isArray(b.tags) ? b.tags : [],
          draft: !!b.draft,
          body: b.body,
        }),
      );
      return send(res, 200, { ok: true, slug });
    }

    if (route === "POST /api/delete") {
      const b = await readBody(req);
      if (!okSlug(String(b.slug ?? ""))) return send(res, 400, { error: "bad slug" });
      await removePost(b.slug);
      return send(res, 200, { ok: true });
    }

    // Mock of the Google Apps Script Web App (read via GET, write via POST).
    if (url.pathname === "/mock-sheet") {
      if (req.method === "OPTIONS") {
        res.writeHead(204, {
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "GET,POST,OPTIONS",
          "access-control-allow-headers": "*",
        });
        return res.end();
      }
      if (req.method === "GET") return mockRespond(res, MOCK);
      if (req.method === "POST") {
        const b = await readBody(req);
        if (b.token !== MOCK_TOKEN) return mockRespond(res, { error: "unauthorized" });
        if (b.action === "ping") return mockRespond(res, { ok: true });
        if (b.action === "saveSettings") Object.assign(MOCK.settings, b.settings || {});
        else if (b.action === "savePost") {
          const post = b.post || {};
          const i = MOCK.posts.findIndex((p) => String(p.slug) === String(post.slug));
          if (i >= 0) MOCK.posts[i] = post;
          else MOCK.posts.push(post);
        } else if (b.action === "deletePost") {
          MOCK.posts = MOCK.posts.filter((p) => String(p.slug) !== String(b.slug));
        } else if (b.action === "saveExperience") {
          const x = b.experience || {};
          if (x._row) {
            const i = MOCK.experience.findIndex((e) => e._row === x._row);
            if (i >= 0) MOCK.experience[i] = { ...x };
            else MOCK.experience.push({ ...x, _row: nextRow(MOCK.experience) });
          } else {
            MOCK.experience.push({ ...x, _row: nextRow(MOCK.experience) });
          }
        } else if (b.action === "deleteExperience") {
          MOCK.experience = MOCK.experience.filter((e) => e._row !== b.row);
        } else if (b.action === "saveProject") {
          const pr = b.project || {};
          const i = MOCK.projects.findIndex((x) => String(x.slug) === String(pr.slug));
          if (i >= 0) MOCK.projects[i] = { ...pr };
          else MOCK.projects.push({ ...pr });
        } else if (b.action === "deleteProject") {
          MOCK.projects = MOCK.projects.filter((x) => String(x.slug) !== String(b.slug));
        }
        return mockRespond(res, MOCK);
      }
    }

    send(res, 404, { error: "not found" });
  } catch (e) {
    send(res, 500, { error: String(e?.message ?? e) });
  }
}).listen(PORT, "127.0.0.1", () => {
  console.log(`admin → http://localhost:${PORT}`);
});

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>admin — portfolio</title>
<style>
  :root { --ink:#101010; --soft:#4a4a4a; --faint:#8f8f8f; --dim:#c2c2c2; --rule:#e8e8e8; --red:#e02d00; }
  * { box-sizing:border-box; }
  body { font:15px/1.6 ui-sans-serif, system-ui, sans-serif; color:var(--ink); background:#fff;
         max-width:680px; margin:0 auto; padding:56px 20px 96px; }
  h1 { font-size:15px; font-weight:600; letter-spacing:-0.01em; margin:0; }
  .eyebrow { font:11px ui-monospace, monospace; text-transform:uppercase; letter-spacing:.16em; color:var(--faint); }
  header { display:flex; justify-content:space-between; align-items:baseline; padding-bottom:16px; }
  section { border-top:1px solid var(--rule); padding:28px 0; }
  label { display:block; margin:16px 0 5px; font:11px ui-monospace, monospace; text-transform:uppercase;
          letter-spacing:.12em; color:var(--faint); }
  input[type=text], input[type=date], input[type=url], textarea {
    width:100%; border:1px solid var(--rule); border-radius:0; padding:9px 11px;
    font:14px/1.5 ui-sans-serif, system-ui, sans-serif; background:#fff; outline:none; }
  textarea { font-family:ui-monospace, monospace; font-size:13px; resize:vertical; }
  input:focus, textarea:focus { border-color:var(--ink); }
  button { border:1px solid var(--ink); border-radius:0; background:var(--ink); color:#fff; padding:9px 16px;
           font:11px ui-monospace, monospace; text-transform:uppercase; letter-spacing:.1em; cursor:pointer; }
  button:hover { background:#fff; color:var(--ink); }
  button.ghost { background:#fff; color:var(--ink); }
  button.ghost:hover { background:var(--ink); color:#fff; }
  button.quiet { border:0; background:none; color:var(--faint); padding:0; }
  button.quiet:hover { color:var(--ink); }
  button.danger:hover { color:var(--red); }
  .actions { display:flex; gap:10px; align-items:center; margin-top:20px; }
  .saved { font:11px ui-monospace, monospace; text-transform:uppercase; letter-spacing:.12em;
           color:var(--faint); opacity:0; transition:opacity .25s; }
  .saved.on { opacity:1; }
  .row2 { display:grid; grid-template-columns:1fr 1fr; gap:12px; }
  .post { display:flex; gap:14px; align-items:baseline; padding:12px 0; border-bottom:1px solid var(--rule); }
  .post .date { font:11px ui-monospace, monospace; color:var(--faint); width:88px; flex-shrink:0;
                font-variant-numeric:tabular-nums; }
  .post .title { font-weight:500; flex:1; }
  .post .badge { font:10px ui-monospace, monospace; text-transform:uppercase; letter-spacing:.1em;
                 color:var(--faint); border:1px solid var(--rule); padding:1px 6px; }
  .check { display:flex; gap:10px; align-items:center; margin-top:16px; }
  .check label { margin:0; }
  .empty { color:var(--faint); font-size:14px; padding:14px 0; }
  #post-form { display:none; border-top:1px dashed var(--rule); margin-top:18px; padding-top:6px; }
  #post-form.on { display:block; }
</style>
</head>
<body>
<header>
  <h1>admin</h1>
  <span class="eyebrow">local only · edits the repo files</span>
</header>

<section>
  <div class="eyebrow">song of the day</div>
  <div class="row2">
    <div><label for="m-title">title</label><input id="m-title" type="text"></div>
    <div><label for="m-artist">artist</label><input id="m-artist" type="text"></div>
  </div>
  <label for="m-note">note (optional)</label><input id="m-note" type="text">
  <label for="m-url">listen url (optional)</label><input id="m-url" type="url" placeholder="https://…">
  <div class="actions">
    <button id="m-save">save song</button>
    <span class="saved" id="m-saved">saved — updated stamped today</span>
  </div>
</section>

<section>
  <div class="eyebrow">availability</div>
  <div class="check">
    <input id="a-on" type="checkbox">
    <label for="a-on">show "available for …" on the homepage</label>
  </div>
  <label for="a-for">available for</label><input id="a-for" type="text" placeholder="freelance &amp; full-time">
  <div class="actions">
    <button id="a-save">save availability</button>
    <span class="saved" id="a-saved">saved</span>
  </div>
</section>

<section>
  <div style="display:flex; justify-content:space-between; align-items:baseline;">
    <div class="eyebrow">posts</div>
    <button class="quiet" id="p-new">+ new post</button>
  </div>
  <div id="p-list"></div>

  <div id="post-form">
    <label for="p-title">title</label><input id="p-title" type="text">
    <div class="row2">
      <div><label for="p-slug">slug</label><input id="p-slug" type="text"></div>
      <div><label for="p-date">date</label><input id="p-date" type="date"></div>
    </div>
    <label for="p-excerpt">excerpt</label><input id="p-excerpt" type="text">
    <label for="p-tags">tags (comma separated)</label><input id="p-tags" type="text" placeholder="engineering, astro">
    <div class="check">
      <input id="p-draft" type="checkbox">
      <label for="p-draft">draft (hidden from the site)</label>
    </div>
    <label for="p-body">body (markdown / mdx)</label>
    <textarea id="p-body" rows="16"></textarea>
    <div class="actions">
      <button id="p-save">save post</button>
      <button class="ghost" id="p-cancel">cancel</button>
      <span class="saved" id="p-saved">saved</span>
    </div>
  </div>
</section>

<script>
var $ = function (s) { return document.querySelector(s); };
var editing = null;      // original slug while editing, null while creating
var slugTouched = false;

function api(path, body) {
  var opts = body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : undefined;
  return fetch(path, opts).then(function (r) {
    return r.json().then(function (j) {
      if (!r.ok) throw new Error(j.error || r.status);
      return j;
    });
  });
}
function esc(s) {
  return String(s).replace(/[&<>"]/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
  });
}
function flash(id) {
  var el = $(id);
  el.classList.add("on");
  setTimeout(function () { el.classList.remove("on"); }, 2200);
}
function slugify(t) {
  return t.toLowerCase().replace(/['\\u2019]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}
function fail(e) { alert(e.message || e); }

function renderPosts(posts) {
  var box = $("#p-list");
  if (!posts.length) { box.innerHTML = '<div class="empty">no posts yet — write the first one.</div>'; return; }
  box.innerHTML = posts.map(function (p) {
    return '<div class="post">' +
      '<span class="date">' + esc(p.date) + '</span>' +
      '<span class="title">' + esc(p.title) + '</span>' +
      (p.draft ? '<span class="badge">draft</span>' : '') +
      '<button class="quiet" data-edit="' + esc(p.slug) + '">edit</button>' +
      '<button class="quiet danger" data-del="' + esc(p.slug) + '">delete</button>' +
      '</div>';
  }).join("");
}

function load() {
  return api("/api/state").then(function (s) {
    $("#m-title").value = s.songOfTheDay.title || "";
    $("#m-artist").value = s.songOfTheDay.artist || "";
    $("#m-note").value = s.songOfTheDay.note || "";
    $("#m-url").value = s.songOfTheDay.url || "";
    $("#a-on").checked = !!s.available;
    $("#a-for").value = s.availableFor || "";
    renderPosts(s.posts);
  }).catch(fail);
}

function openForm(post) {
  editing = post ? post.slug : null;
  slugTouched = !!post;
  $("#p-title").value = post ? post.title : "";
  $("#p-slug").value = post ? post.slug : "";
  $("#p-date").value = post ? String(post.date).slice(0, 10) : new Date().toISOString().slice(0, 10);
  $("#p-excerpt").value = post ? (post.excerpt || "") : "";
  $("#p-tags").value = post ? (post.tags || []).join(", ") : "";
  $("#p-draft").checked = post ? !!post.draft : false;
  $("#p-body").value = post ? post.body : "";
  $("#post-form").classList.add("on");
  $("#p-title").focus();
}
function closeForm() {
  $("#post-form").classList.remove("on");
  editing = null;
}

$("#m-save").onclick = function () {
  api("/api/music", {
    title: $("#m-title").value, artist: $("#m-artist").value,
    note: $("#m-note").value, url: $("#m-url").value,
  }).then(function () { flash("#m-saved"); }).catch(fail);
};

$("#a-save").onclick = function () {
  api("/api/availability", { available: $("#a-on").checked, availableFor: $("#a-for").value })
    .then(function () { flash("#a-saved"); }).catch(fail);
};

$("#p-new").onclick = function () { openForm(null); };
$("#p-cancel").onclick = closeForm;

$("#p-title").addEventListener("input", function () {
  if (!slugTouched) $("#p-slug").value = slugify($("#p-title").value);
});
$("#p-slug").addEventListener("input", function () { slugTouched = true; });

$("#p-save").onclick = function () {
  var tags = $("#p-tags").value.split(",").map(function (t) { return t.trim(); }).filter(Boolean);
  api("/api/post", {
    originalSlug: editing,
    slug: $("#p-slug").value,
    title: $("#p-title").value,
    date: $("#p-date").value,
    excerpt: $("#p-excerpt").value,
    tags: tags,
    draft: $("#p-draft").checked,
    body: $("#p-body").value,
  }).then(function () { flash("#p-saved"); closeForm(); return load(); }).catch(fail);
};

$("#p-list").addEventListener("click", function (e) {
  var edit = e.target.getAttribute("data-edit");
  var del = e.target.getAttribute("data-del");
  if (edit) api("/api/post?slug=" + edit).then(openForm).catch(fail);
  if (del && confirm("Delete “" + del + "”?")) {
    api("/api/delete", { slug: del }).then(load).catch(fail);
  }
});

load();
</script>
</body>
</html>`;
