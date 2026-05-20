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
    /<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i,
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (m?.[1]) return m[1];
  }
  return null;
}

async function downloadTo(url: string, dest: string): Promise<boolean> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return false;
    const buf = Buffer.from(await res.arrayBuffer());
    await mkdir(path.dirname(dest), { recursive: true });
    await writeFile(dest, buf);
    return true;
  } catch {
    return false;
  }
}

function extFromUrl(u: string): string {
  try {
    const p = new URL(u).pathname.toLowerCase();
    const m = p.match(/\.(png|jpe?g|webp|avif|gif|svg)$/);
    return m ? m[1].replace('jpeg', 'jpg') : 'png';
  } catch {
    return 'png';
  }
}

export async function resolveOgImage(slug: string, url: string | undefined): Promise<string | null> {
  if (!url) return null;

  const manifest = await readManifest();
  const cached = manifest[slug];
  const now = Date.now();

  if (cached && now - cached.fetchedAt < TTL_MS) {
    if (cached.file && existsSync(path.join(PUBLIC_DIR, cached.file))) {
      return `/og/${cached.file}`;
    }
    if (cached.file === null) return null;
  }

  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(8000),
      headers: { 'user-agent': 'Mozilla/5.0 (portfolio og-fetcher)' },
    });
    if (!res.ok) throw new Error(String(res.status));
    const html = await res.text();
    const og = extractOg(html);
    if (!og) {
      manifest[slug] = { fetchedAt: now, file: null };
      await writeManifest(manifest);
      return null;
    }
    const absolute = new URL(og, url).toString();
    const ext = extFromUrl(absolute);
    const file = `${slug}.${ext}`;
    const ok = await downloadTo(absolute, path.join(PUBLIC_DIR, file));
    if (!ok) throw new Error('download');
    manifest[slug] = { fetchedAt: now, file };
    await writeManifest(manifest);
    return `/og/${file}`;
  } catch {
    manifest[slug] = { fetchedAt: now, file: null };
    await writeManifest(manifest);
    return null;
  }
}

export async function resolveProjectImages<T extends { slug: string; image?: string; url?: string }>(
  projects: T[],
): Promise<(T & { resolvedImage: string | null })[]> {
  return Promise.all(
    projects.map(async (p) => {
      if (p.image && p.image.trim()) return { ...p, resolvedImage: p.image };
      const resolved = await resolveOgImage(p.slug, p.url);
      return { ...p, resolvedImage: resolved };
    }),
  );
}
