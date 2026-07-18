// Client-side loader for the Google Sheet (via an Apps Script Web App endpoint).
// The endpoint returns { settings: {key:value}, posts: [...] }. Fully public read,
// no API key. If `sheetApi` is empty or the fetch fails, callers get null and the
// page keeps its static build-time content. See /admin for setup.
import site from "../data/site.json";

export interface SheetPost {
  slug: string;
  title: string;
  date: string; // yyyy-mm-dd
  excerpt: string;
  tags: string[];
  draft: boolean;
  body: string;
}

export interface SheetExperience {
  row: number | null;
  role: string;
  company: string;
  location: string;
  start: string;
  end: string;
  current: boolean;
  description: string;
}

export interface SheetProject {
  slug: string;
  title: string;
  tagline: string;
  role: string;
  status: string;
  description: string;
  longDescription: string;
  stack: string[];
  url: string;
  image: string;
  accent: string;
  featured: boolean;
}

export interface SheetData {
  settings: Record<string, string>;
  posts: SheetPost[];
  experience: SheetExperience[];
  projects: SheetProject[];
}

function isTrue(v: unknown): boolean {
  return v === true || String(v ?? "").trim().toLowerCase() === "true";
}

function parseTags(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(String).map((t) => t.trim()).filter(Boolean);
  return String(v ?? "")
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
}

function normDate(v: unknown): string {
  if (!v) return "";
  const s = String(v);
  const m = s.match(/^\d{4}-\d{2}-\d{2}/);
  if (m) return m[0];
  const dt = new Date(s);
  return isNaN(dt.getTime()) ? s : dt.toISOString().slice(0, 10);
}

let cache: Promise<SheetData | null> | null = null;

export function loadSheet(): Promise<SheetData | null> {
  if (cache) return cache;
  const url = (site as { sheetApi?: string }).sheetApi;
  if (!url) {
    cache = Promise.resolve(null);
    return cache;
  }
  cache = fetch(url, { redirect: "follow" })
    .then((r) => (r.ok ? r.json() : null))
    .then((raw: any) => {
      if (!raw) return null;
      const settings: Record<string, string> = {};
      for (const [k, v] of Object.entries(raw.settings ?? {})) {
        settings[k] = v == null ? "" : String(v);
      }
      const posts: SheetPost[] = (raw.posts ?? [])
        .filter((p: any) => p && p.slug)
        .map((p: any) => ({
          slug: String(p.slug).trim(),
          title: String(p.title ?? ""),
          date: normDate(p.date),
          excerpt: String(p.excerpt ?? ""),
          tags: parseTags(p.tags),
          draft: isTrue(p.draft),
          body: String(p.body ?? ""),
        }));
      const experience: SheetExperience[] = (raw.experience ?? [])
        .filter((x: any) => x && (x.role || x.company))
        .map((x: any) => ({
          row: x._row ?? null,
          role: String(x.role ?? ""),
          company: String(x.company ?? ""),
          location: String(x.location ?? ""),
          start: x.start == null ? "" : String(x.start),
          end: x.end == null ? "" : String(x.end),
          current: isTrue(x.current),
          description: String(x.description ?? ""),
        }));
      const projects: SheetProject[] = (raw.projects ?? [])
        .filter((p: any) => p && p.slug)
        .map((p: any) => ({
          slug: String(p.slug).trim(),
          title: String(p.title ?? ""),
          tagline: String(p.tagline ?? ""),
          role: String(p.role ?? ""),
          status: String(p.status ?? ""),
          description: String(p.description ?? ""),
          longDescription: String(p.longDescription ?? ""),
          stack: parseTags(p.stack),
          url: String(p.url ?? ""),
          image: String(p.image ?? ""),
          accent: String(p.accent ?? ""),
          featured: isTrue(p.featured),
        }));
      return { settings, posts, experience, projects };
    })
    .catch(() => null);
  return cache;
}

export function fmtDate(d: string): string {
  if (!d) return "";
  const dt = new Date(d.length <= 10 ? d + "T00:00:00" : d);
  if (isNaN(dt.getTime())) return d;
  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  }).format(dt);
}

// Minimal, dependency-free Markdown → HTML for client-rendered blog bodies.
// Handles headings, bold/italic, inline + fenced code, links, images, lists,
// blockquotes, hr and paragraphs. HTML in the source is escaped first.
export function mdToHtml(md: string): string {
  const esc = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  const inline = (s: string) =>
    esc(s)
      .replace(/`([^`]+)`/g, (_m, c) => `<code>${c}</code>`)
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>")
      .replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, '<img alt="$1" src="$2">')
      .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');

  const lines = String(md).replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  let para: string[] = [];
  let list: string[] | null = null;
  let listType = "ul";
  let i = 0;

  const flushPara = () => {
    if (para.length) {
      out.push(`<p>${inline(para.join(" "))}</p>`);
      para = [];
    }
  };
  const flushList = () => {
    if (list) {
      out.push(`<${listType}>${list.join("")}</${listType}>`);
      list = null;
    }
  };

  while (i < lines.length) {
    const line = lines[i];

    if (/^```/.test(line)) {
      flushPara();
      flushList();
      const buf: string[] = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) {
        buf.push(lines[i]);
        i++;
      }
      i++; // consume closing fence
      out.push(`<pre><code>${esc(buf.join("\n"))}</code></pre>`);
      continue;
    }

    if (/^\s*$/.test(line)) {
      flushPara();
      flushList();
      i++;
      continue;
    }

    let m: RegExpMatchArray | null;
    if ((m = line.match(/^(#{1,3})\s+(.*)$/))) {
      flushPara();
      flushList();
      const lvl = m[1].length;
      out.push(`<h${lvl}>${inline(m[2])}</h${lvl}>`);
      i++;
      continue;
    }
    if (/^\s*[-*]\s+/.test(line)) {
      flushPara();
      if (list && listType !== "ul") flushList();
      listType = "ul";
      list = list || [];
      list.push(`<li>${inline(line.replace(/^\s*[-*]\s+/, ""))}</li>`);
      i++;
      continue;
    }
    if (/^\s*\d+\.\s+/.test(line)) {
      flushPara();
      if (list && listType !== "ol") flushList();
      listType = "ol";
      list = list || [];
      list.push(`<li>${inline(line.replace(/^\s*\d+\.\s+/, ""))}</li>`);
      i++;
      continue;
    }
    if (/^>\s?/.test(line)) {
      flushPara();
      flushList();
      out.push(`<blockquote>${inline(line.replace(/^>\s?/, ""))}</blockquote>`);
      i++;
      continue;
    }
    if (/^(-{3,}|\*{3,})\s*$/.test(line)) {
      flushPara();
      flushList();
      out.push("<hr>");
      i++;
      continue;
    }

    para.push(line);
    i++;
  }

  flushPara();
  flushList();
  return out.join("\n");
}
