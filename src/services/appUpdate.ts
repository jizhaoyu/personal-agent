export const GITHUB_OWNER = 'jizhaoyu';
export const GITHUB_REPO = 'personal-agent';
export const GITHUB_RELEASES_API_URL = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest`;
export const GITHUB_RELEASES_PAGE_URL = `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/releases`;

const ALLOWED_ASSET_HOSTS = new Set([
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com',
  'github-releases.githubusercontent.com',
]);

export type UpdatePlatform = 'android' | 'desktop' | 'web';

export interface GitHubReleaseAsset {
  name: string;
  downloadUrl: string;
  size: number;
}

export interface SanitizedGitHubRelease {
  tagName: string;
  releaseName: string;
  publishedAt: string;
  htmlUrl: string;
  body: string;
  prerelease: boolean;
  assets: GitHubReleaseAsset[];
}

export interface RawReleaseFetchResult {
  status: 'ok' | 'no-release' | 'rate-limited' | 'error';
  httpStatus?: number;
  message?: string;
  release?: SanitizedGitHubRelease;
}

export interface UpdateCheckResult {
  outcome: 'up-to-date' | 'update-available' | 'no-release' | 'rate-limited' | 'error';
  platform: UpdatePlatform;
  checkedAt: string;
  currentVersion: string;
  currentVersionCode?: number;
  latestVersion?: string;
  latestVersionCode?: number;
  releaseTitle?: string;
  publishedAt?: string;
  notesSummary?: string;
  downloadUrl?: string;
  releaseUrl: string;
  assetName?: string;
  assetSizeBytes?: number;
  expectedSha256?: string;
  httpStatus?: number;
  errorMessage?: string;
}

export function validateReleaseExternalUrl(rawUrl: unknown): string | null {
  if (typeof rawUrl !== 'string') return null;
  const trimmed = rawUrl.trim();
  if (!trimmed || trimmed.length > 2048 || /[\s\\\u0000-\u001f\u007f]/.test(trimmed)) return null;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) return null;
  const host = parsed.hostname.toLowerCase();
  if (host === 'github.com') {
    const repoPrefix = `/${GITHUB_OWNER}/${GITHUB_REPO}`.toLowerCase();
    const pathLower = parsed.pathname.toLowerCase();
    if (pathLower !== repoPrefix && !pathLower.startsWith(`${repoPrefix}/`)) return null;
    return parsed.href;
  }
  if (ALLOWED_ASSET_HOSTS.has(host)) {
    return parsed.href;
  }
  return null;
}

interface ParsedSemver {
  major: number;
  minor: number;
  patch: number;
  preRank: number;
  preNum: number;
}

function parsePreRank(pre?: string): { preRank: number; preNum: number } {
  if (!pre) return { preRank: 100, preNum: 0 };
  const lower = pre.toLowerCase();
  if (lower === 'trial' || lower === 'internal-trial') {
    return { preRank: 100, preNum: 0 };
  }
  const numMatch = lower.match(/(\d+)/);
  const preNum = numMatch ? Number.parseInt(numMatch[1], 10) : 0;
  if (lower.startsWith('alpha') || lower.startsWith('a.')) return { preRank: 10, preNum };
  if (lower.startsWith('beta') || lower.startsWith('b.')) return { preRank: 20, preNum };
  if (lower.startsWith('rc')) return { preRank: 30, preNum };
  return { preRank: 50, preNum };
}

export function parseVersionTuple(raw: unknown): ParsedSemver | null {
  if (typeof raw !== 'string') return null;
  const match = raw.trim().match(/(\d+)\.(\d+)(?:\.(\d+))?(?:-([A-Za-z0-9._-]+))?/);
  if (!match) return null;
  const major = Number.parseInt(match[1], 10);
  const minor = Number.parseInt(match[2], 10);
  const patch = match[3] ? Number.parseInt(match[3], 10) : 0;
  if (![major, minor, patch].every(Number.isFinite)) return null;
  const { preRank, preNum } = parsePreRank(match[4]);
  return { major, minor, patch, preRank, preNum };
}

export function compareVersions(a: string, b: string): -1 | 0 | 1 | null {
  const va = parseVersionTuple(a);
  const vb = parseVersionTuple(b);
  if (!va || !vb) return null;
  for (const [x, y] of [
    [va.major, vb.major],
    [va.minor, vb.minor],
    [va.patch, vb.patch],
    [va.preRank, vb.preRank],
    [va.preNum, vb.preNum],
  ]) {
    if (x < y) return -1;
    if (x > y) return 1;
  }
  return 0;
}

export function extractAndroidVersionCode(body: string): number | undefined {
  if (typeof body !== 'string' || !body) return undefined;
  const match = body.match(/(?:android[_ -]?version[_ -]?code|versionCode)\s*[:=]\s*(\d{2,9})/i);
  if (!match) return undefined;
  const parsed = Number.parseInt(match[1], 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

export function extractExpectedSha256(body: string, assetName?: string, platform?: UpdatePlatform): string | undefined {
  if (typeof body !== 'string' || !body) return undefined;
  const lines = body.split(/\r?\n/);
  if (assetName) {
    const lowerAsset = assetName.toLowerCase();
    for (const line of lines) {
      if (line.toLowerCase().includes(lowerAsset)) {
        const match = line.match(/\b([a-fA-F0-9]{64})\b/);
        if (match) return match[1].toLowerCase();
      }
    }
  }
  const keyword = platform === 'android' ? /apk|android/i : platform === 'desktop' ? /win32|win64|windows|desktop|\.exe|\.zip/i : null;
  if (keyword) {
    for (const line of lines) {
      if (keyword.test(line)) {
        const match = line.match(/\b([a-fA-F0-9]{64})\b/);
        if (match) return match[1].toLowerCase();
      }
    }
  }
  return undefined;
}

export function summarizeReleaseNotes(body: string, maxLength = 360): string {
  if (typeof body !== 'string' || !body.trim()) return '';
  const cleaned = body
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '$1')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line && !/^[a-fA-F0-9]{64}(\s+.*)?$/.test(line) && !/^(?:android[_ -]?version[_ -]?code|versionCode)\s*[:=]/i.test(line))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (cleaned.length <= maxLength) return cleaned;
  return `${cleaned.slice(0, maxLength - 1).trimEnd()}…`;
}

export function sanitizeGitHubReleasePayload(raw: unknown): SanitizedGitHubRelease {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Invalid GitHub release response');
  }
  const src = raw as Record<string, unknown>;
  const tagName = typeof src.tag_name === 'string'
    ? src.tag_name.trim().slice(0, 80)
    : typeof src.tagName === 'string'
      ? src.tagName.trim().slice(0, 80)
      : '';
  if (!tagName) {
    throw new Error('Release tag_name is missing');
  }
  const releaseName = typeof src.name === 'string' && src.name.trim()
    ? src.name.trim().slice(0, 160)
    : typeof src.releaseName === 'string' && src.releaseName.trim()
      ? src.releaseName.trim().slice(0, 160)
      : tagName;
  const publishedAt = typeof src.published_at === 'string'
    ? src.published_at.slice(0, 40)
    : typeof src.publishedAt === 'string'
      ? src.publishedAt.slice(0, 40)
      : '';
  const safeHtmlUrl = validateReleaseExternalUrl(src.html_url ?? src.htmlUrl) || GITHUB_RELEASES_PAGE_URL;
  const body = typeof src.body === 'string' ? src.body.slice(0, 8000) : '';
  const prerelease = src.prerelease === true;
  const rawAssets = Array.isArray(src.assets) ? src.assets.slice(0, 20) : [];
  const assets: GitHubReleaseAsset[] = [];
  for (const item of rawAssets) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const entry = item as Record<string, unknown>;
    const name = typeof entry.name === 'string' ? entry.name.trim().slice(0, 160) : '';
    const downloadUrl = validateReleaseExternalUrl(entry.browser_download_url ?? entry.downloadUrl);
    const size = typeof entry.size === 'number' && Number.isFinite(entry.size) && entry.size >= 0 ? entry.size : 0;
    if (name && downloadUrl) {
      assets.push({ name, downloadUrl, size });
    }
  }
  return { tagName, releaseName, publishedAt, htmlUrl: safeHtmlUrl, body, prerelease, assets };
}

export function pickPlatformDownload(
  release: SanitizedGitHubRelease,
  platform: UpdatePlatform,
): { downloadUrl: string; assetName?: string; assetSizeBytes?: number } {
  let asset: GitHubReleaseAsset | undefined;
  if (platform === 'android') {
    asset = release.assets.find(a => /release-signed\.apk$/i.test(a.name))
      || release.assets.find(a => /\.apk$/i.test(a.name));
  } else if (platform === 'desktop') {
    asset = release.assets.find(a => /(win32|win64|windows|x64|desktop).*\.(exe|msi|zip)$/i.test(a.name))
      || release.assets.find(a => /\.(exe|msi|zip)$/i.test(a.name));
  }
  return {
    downloadUrl: asset?.downloadUrl || release.htmlUrl || GITHUB_RELEASES_PAGE_URL,
    ...(asset ? { assetName: asset.name, assetSizeBytes: asset.size } : {}),
  };
}

export function evaluateReleaseCheck(
  fetchResult: RawReleaseFetchResult,
  context: {
    platform: UpdatePlatform;
    currentVersion: string;
    currentAndroidVersionCode?: number;
    checkedAt?: string;
  },
): UpdateCheckResult {
  const checkedAt = context.checkedAt || new Date().toISOString();
  const base = {
    platform: context.platform,
    checkedAt,
    currentVersion: context.currentVersion,
    ...(typeof context.currentAndroidVersionCode === 'number' && context.currentAndroidVersionCode > 0
      ? { currentVersionCode: context.currentAndroidVersionCode }
      : {}),
    releaseUrl: GITHUB_RELEASES_PAGE_URL,
  };

  if (fetchResult.status === 'no-release') {
    return { ...base, outcome: 'no-release', httpStatus: fetchResult.httpStatus ?? 404 };
  }
  if (fetchResult.status === 'rate-limited') {
    return { ...base, outcome: 'rate-limited', httpStatus: fetchResult.httpStatus, errorMessage: fetchResult.message };
  }
  if (fetchResult.status !== 'ok' || !fetchResult.release) {
    return { ...base, outcome: 'error', httpStatus: fetchResult.httpStatus, errorMessage: fetchResult.message };
  }

  const release = sanitizeGitHubReleasePayload(fetchResult.release);
  const releaseUrl = validateReleaseExternalUrl(release.htmlUrl) || GITHUB_RELEASES_PAGE_URL;
  const latestVersionCode = extractAndroidVersionCode(release.body);
  const { downloadUrl, assetName, assetSizeBytes } = pickPlatformDownload(release, context.platform);
  const expectedSha256 = extractExpectedSha256(release.body, assetName, context.platform);
  const notesSummary = summarizeReleaseNotes(release.body);

  let isNewer = false;
  if (!release.prerelease) {
    const cmp = compareVersions(release.tagName, context.currentVersion);
    if (cmp !== null && cmp > 0) {
      isNewer = true;
    } else if (
      context.platform === 'android'
      && typeof context.currentAndroidVersionCode === 'number'
      && context.currentAndroidVersionCode > 0
      && typeof latestVersionCode === 'number'
      && latestVersionCode > context.currentAndroidVersionCode
      && (cmp === null || cmp >= 0)
    ) {
      isNewer = true;
    }
  }

  return {
    ...base,
    outcome: isNewer ? 'update-available' : 'up-to-date',
    latestVersion: release.tagName,
    ...(typeof latestVersionCode === 'number' ? { latestVersionCode } : {}),
    releaseTitle: release.releaseName,
    publishedAt: release.publishedAt,
    notesSummary,
    downloadUrl,
    releaseUrl,
    ...(assetName ? { assetName, assetSizeBytes } : {}),
    ...(expectedSha256 ? { expectedSha256 } : {}),
    httpStatus: fetchResult.httpStatus ?? 200,
  };
}

export async function fetchGitHubLatestReleaseBrowser(
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<RawReleaseFetchResult> {
  if (typeof fetchImpl !== 'function') {
    return { status: 'error', message: 'Fetch unavailable' };
  }
  const controller = typeof AbortController === 'function' ? new AbortController() : undefined;
  const timer = controller ? setTimeout(() => controller.abort(), 8000) : undefined;
  try {
    const response = await fetchImpl(GITHUB_RELEASES_API_URL, {
      method: 'GET',
      cache: 'no-store',
      headers: { Accept: 'application/vnd.github+json' },
      ...(controller ? { signal: controller.signal } : {}),
    });
    if (response.url) {
      let host = '';
      try { host = new URL(response.url).hostname.toLowerCase(); } catch {}
      if (host !== 'api.github.com') {
        return { status: 'error', message: 'Unexpected release redirect host' };
      }
    }
    if (response.status === 404) return { status: 'no-release', httpStatus: 404 };
    if (response.status === 403 || response.status === 429) {
      return { status: 'rate-limited', httpStatus: response.status };
    }
    if (!response.ok) {
      return { status: 'error', httpStatus: response.status, message: `HTTP ${response.status}` };
    }
    const text = await response.text();
    if (text.length > 262144) {
      return { status: 'error', message: 'Release response too large' };
    }
    const release = sanitizeGitHubReleasePayload(JSON.parse(text));
    return { status: 'ok', httpStatus: 200, release };
  } catch (error) {
    return { status: 'error', message: error instanceof Error ? error.message : 'Network error' };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export async function checkForAppUpdates(options: {
  platform: UpdatePlatform;
  currentVersion: string;
  currentAndroidVersionCode?: number;
  electronAPI?: Window['electronAPI'];
  fetchImpl?: typeof fetch;
}): Promise<UpdateCheckResult> {
  let rawResult: RawReleaseFetchResult;
  if (options.electronAPI?.checkForUpdates) {
    try {
      const payload = await options.electronAPI.checkForUpdates();
      if (payload && typeof payload === 'object' && 'status' in payload) {
        rawResult = payload as RawReleaseFetchResult;
      } else {
        rawResult = { status: 'error', message: 'Invalid update bridge payload' };
      }
    } catch (error) {
      rawResult = { status: 'error', message: error instanceof Error ? error.message : 'Update check failed' };
    }
  } else {
    rawResult = await fetchGitHubLatestReleaseBrowser(options.fetchImpl);
  }

  return evaluateReleaseCheck(rawResult, {
    platform: options.platform,
    currentVersion: options.currentVersion,
    currentAndroidVersionCode: options.currentAndroidVersionCode,
  });
}

export async function openReleaseExternalUrl(
  rawUrl: string,
  electronAPI?: Window['electronAPI'],
): Promise<boolean> {
  const safeUrl = validateReleaseExternalUrl(rawUrl);
  if (!safeUrl) return false;
  if (electronAPI?.openExternalUrl) {
    const res = await electronAPI.openExternalUrl(safeUrl);
    return !!res?.opened;
  }
  if (typeof window !== 'undefined' && typeof window.open === 'function') {
    window.open(safeUrl, '_blank', 'noopener,noreferrer');
    return true;
  }
  return false;
}
