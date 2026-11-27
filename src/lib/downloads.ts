import type { Release } from '../types';

export function downloadUrl(file: string): string {
  return new URL(`${import.meta.env.BASE_URL}download/${encodeURIComponent(file)}`, document.baseURI).href;
}

export function isRelease(value: unknown): value is Release {
  if (!value || typeof value !== 'object') return false;
  const release = value as Partial<Release>;
  return (release.platform === 'win32' || release.platform === 'darwin' || release.platform === 'android')
    && (release.arch === 'x64' || release.arch === 'arm64' || release.arch === 'universal')
    && typeof release.name === 'string'
    && typeof release.size === 'string'
    && typeof release.file === 'string'
    && /^ChromiumCore-[\d.]+-(win32|darwin|android)-(x64|arm64|universal)\.(zip|apk|exe)$/.test(release.file)
    && typeof release.sha256 === 'string'
    && /^[a-f\d]{64}$/i.test(release.sha256);
}

export async function archiveExists(file: string, signal?: AbortSignal): Promise<boolean> {
  try {
    const response = await fetch(downloadUrl(file), { method: 'HEAD', cache: 'no-store', signal });
    const contentType = response.headers.get('content-type') || '';
    const length = response.headers.get('content-length');
    // SPA hosts can return index.html with status 200 for a missing ZIP.
    return response.ok && !/^text\//i.test(contentType) && (!length || Number(length) >= 4);
  } catch {
    return false;
  }
}