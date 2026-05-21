import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { URL } from 'node:url';

const PUBLIC_DIR = path.resolve(process.cwd(), 'public', 'og');
const CACHE_DIR = path.resolve(process.cwd(), '.cache', 'og');
const MANIFEST = path.join(CACHE_DIR, 'manifest.json');
const TTL_MS = 7 * 24 * 60 * 60 * 1000;

type Manifest = Record<string, { fetchedAt: number; file: string | null }>;

async function readManifest(): Promise<Manifest> {
  try {
    return JSON.parse(await readFile(MANIFEST, 'utf8'));
  } catch {
    return {};
  }
}

async function writeManifest(m: Manifest) {
  await mkdir(CACHE_DIR, { recursive: true });
  await writeFile(MANIFEST, JSON.stringify(m, null, 2));
}

function extractOg(html: string): string | null {
  const patterns = [
    /<meta[^>]+property=["']og:image(?::secure_url)?["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image(?::secure_url)?["']/i,
    /<meta[^>]+name=["']twitter:image(?::src)?["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]+name=["']twitter:image(?::src)?["']/i,
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (m?.[1]) return m[1];
  }
  return null;
}

function extFromUrl(u: string): string {
  try {
    const p = new URL(u).pathname.toLowerCase();
    const m = p.match(/\.(png|jpe?g|webp|avif|gif|svg)(?:$|[?#])/);
    return m ? m[1].replace('jpeg', 'jpg') : 'png';
  } catch {
    return 'png';
  }
}

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

function extFromContentType(ct: string | null): string {
  if (!ct) return 'png';
  if (ct.includes('jpeg') || ct.includes('jpg')) return 'jpg';
  if (ct.includes('webp')) return 'webp';
  if (ct.includes('gif')) return 'gif';
  if (ct.includes('avif')) return 'avif';
  return 'png';
}

async function saveImage(buf: Buffer, slug: string, ext: string): Promise<string> {
  const file = `${slug}.${ext}`;
  await mkdir(PUBLIC_DIR, { recursive: true });
  await writeFile(path.join(PUBLIC_DIR, file), buf);
  return file;
}

// 1st choice: the site's declared og:image / twitter:image.
async function fetchOgFile(slug: string, url: string): Promise<string | null> {
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(12000),
      redirect: 'follow',
      headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml' },
    });
    if (!res.ok) return null;
    const html = await res.text();
    const og = extractOg(html);
    if (!og) return null;

    const absolute = new URL(og, res.url || url).toString();
    const imgRes = await fetch(absolute, {
      signal: AbortSignal.timeout(12000),
      redirect: 'follow',
      headers: { 'user-agent': UA },
    });
    if (!imgRes.ok) return null;

    const buf = Buffer.from(await imgRes.arrayBuffer());
    if (buf.byteLength < 512) return null; // tiny = tracking pixel / error img
    return saveImage(buf, slug, extFromUrl(absolute));
  } catch {
    return null;
  }
}

// 2nd choice: a live screenshot of the page (thum.io, no key required).
async function fetchScreenshot(slug: string, url: string): Promise<string | null> {
  try {
    const shot = `https://image.thum.io/get/width/1000/crop/750/${url}`;
    const res = await fetch(shot, {
      signal: AbortSignal.timeout(30000),
      redirect: 'follow',
      headers: { 'user-agent': UA },
    });
    if (!res.ok) return null;
    const ct = res.headers.get('content-type') ?? '';
    if (!ct.startsWith('image/')) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.byteLength < 2048) return null; // too small to be a real render
    return saveImage(buf, slug, extFromContentType(ct));
  } catch {
    return null;
  }
}

export async function resolveProjectImages<
  T extends { slug: string; image?: string; url?: string },
>(projects: T[]): Promise<(T & { resolvedImage: string | null })[]> {
  const manifest = await readManifest();
  const now = Date.now();

  const results = await Promise.all(
    projects.map(async (p) => {
      // 0. "none" opts out — use the branded gradient (good for no-UI backends)
      if (p.image?.trim() === 'none') return { ...p, resolvedImage: null };
      // 1. manual override always wins
      if (p.image && p.image.trim()) return { ...p, resolvedImage: p.image };
      if (!p.url) return { ...p, resolvedImage: null };

      // 2. fresh cache hit
      const cached = manifest[p.slug];
      if (cached && now - cached.fetchedAt < TTL_MS) {
        if (cached.file && existsSync(path.join(PUBLIC_DIR, cached.file))) {
          return { ...p, resolvedImage: `/og/${cached.file}` };
        }
        if (cached.file === null) return { ...p, resolvedImage: null };
      }

      // 3. fetch live: og:image first, then a screenshot. Mutate the shared
      //    (in-memory) manifest synchronously — no concurrent file writes.
      const file = (await fetchOgFile(p.slug, p.url)) ?? (await fetchScreenshot(p.slug, p.url));
      manifest[p.slug] = { fetchedAt: now, file };
      return { ...p, resolvedImage: file ? `/og/${file}` : null };
    }),
  );

  // single write — no concurrent clobbering
  await writeManifest(manifest);
  return results;
}
