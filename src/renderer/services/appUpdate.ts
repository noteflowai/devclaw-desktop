import { getFallbackDownloadUrl,getManualUpdateCheckUrl, getUpdateCheckUrl } from './endpoints';

export const UPDATE_POLL_INTERVAL_MS = 12 * 60 * 60 * 1000;
export const UPDATE_HEARTBEAT_INTERVAL_MS = 30 * 60 * 1000;

type ChangeLogLang = {
  title?: string;
  content?: string[];
};

type PlatformDownload = {
  url?: string;
};

type UpdateApiResponse = {
  code?: number;
  data?: {
    value?: {
      version?: string;
      date?: string;
      changeLog?: {
        ch?: ChangeLogLang;
        en?: ChangeLogLang;
      };
      macIntel?: PlatformDownload;
      macArm?: PlatformDownload;
      windowsX64?: PlatformDownload;
    };
  };
};

type GitHubReleaseAsset = {
  name?: string;
  browser_download_url?: string;
};

type GitHubReleaseResponse = {
  tag_name?: string;
  name?: string;
  body?: string;
  published_at?: string;
  assets?: GitHubReleaseAsset[];
};

export type ChangeLogEntry = { title: string; content: string[] };

export interface AppUpdateDownloadProgress {
  received: number;
  total: number | undefined;
  percent: number | undefined;
  speed: number | undefined;
}

export interface AppUpdateInfo {
  latestVersion: string;
  date: string;
  changeLog: { zh: ChangeLogEntry; en: ChangeLogEntry };
  url: string;
}

const toVersionParts = (version: string): number[] => (
  version
    .split('.')
    .map((part) => {
      const match = part.trim().match(/^\d+/);
      return match ? Number.parseInt(match[0], 10) : 0;
    })
);

const compareVersions = (a: string, b: string): number => {
  const aParts = toVersionParts(a);
  const bParts = toVersionParts(b);
  const maxLength = Math.max(aParts.length, bParts.length);

  for (let i = 0; i < maxLength; i += 1) {
    const left = aParts[i] ?? 0;
    const right = bParts[i] ?? 0;
    if (left > right) return 1;
    if (left < right) return -1;
  }

  return 0;
};

const isNewerVersion = (latestVersion: string, currentVersion: string): boolean => (
  compareVersions(latestVersion, currentVersion) > 0
);

type UpdateValue = NonNullable<NonNullable<UpdateApiResponse['data']>['value']>;

const getPlatformDownloadUrl = (value: UpdateValue | undefined): string => {
  const { platform, arch } = window.electron;

  if (platform === 'darwin') {
    const download = arch === 'arm64' ? value?.macArm : value?.macIntel;
    return download?.url?.trim() || getFallbackDownloadUrl();
  }

  if (platform === 'win32') {
    return value?.windowsX64?.url?.trim() || getFallbackDownloadUrl();
  }

  return getFallbackDownloadUrl();
};

const getGitHubDownloadUrl = (release: GitHubReleaseResponse): string => {
  const assets = Array.isArray(release.assets) ? release.assets : [];
  const { platform, arch } = window.electron;
  const matches = (asset: GitHubReleaseAsset, patterns: RegExp[]) => {
    const name = asset.name || '';
    return Boolean(asset.browser_download_url) && patterns.every((pattern) => pattern.test(name));
  };

  let asset: GitHubReleaseAsset | undefined;
  if (platform === 'darwin') {
    asset = assets.find((item) => (
      arch === 'arm64'
        ? matches(item, [/\.dmg$/i, /arm64|aarch64/i])
        : matches(item, [/\.dmg$/i]) && !/(arm64|aarch64)/i.test(item.name || '')
    ));
  } else if (platform === 'win32') {
    asset = assets.find((item) => matches(item, [/\.exe$/i]));
  } else {
    asset = assets.find((item) => matches(item, [/appimage|\.deb|\.rpm|\.tar\.gz$/i]));
  }

  return asset?.browser_download_url?.trim() || getFallbackDownloadUrl();
};

const parseGitHubReleaseUpdate = (
  payload: GitHubReleaseResponse,
  currentVersion: string,
): AppUpdateInfo | null => {
  const latestVersion = payload.tag_name?.trim().replace(/^v/i, '') || '';
  if (!latestVersion || !isNewerVersion(latestVersion, currentVersion)) {
    console.log(`[AppUpdate] no update available, latestVersion=${latestVersion || 'N/A'}, currentVersion=${currentVersion}`);
    return null;
  }

  const bodyLines = (payload.body || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !/^#+\s*/.test(line))
    .slice(0, 12);
  const title = payload.name?.trim() || payload.tag_name?.trim() || latestVersion;
  const date = payload.published_at?.slice(0, 10) || '';
  const entry = { title, content: bodyLines };

  const result: AppUpdateInfo = {
    latestVersion,
    date,
    changeLog: { zh: entry, en: entry },
    url: getGitHubDownloadUrl(payload),
  };
  console.log(`[AppUpdate] update available: ${currentVersion} -> ${latestVersion}, downloadUrl=${result.url}`);
  return result;
};

export const checkForAppUpdate = async (currentVersion: string, manual?: boolean): Promise<AppUpdateInfo | null> => {
  const url = manual ? getManualUpdateCheckUrl() : getUpdateCheckUrl();
  console.log(`[AppUpdate] checking update, currentVersion=${currentVersion}, url=${url}`);

  const response = await window.electron.api.fetch({
    url,
    method: 'GET',
    headers: {
      Accept: 'application/json',
    },
    expectedStatuses: [404],
  });

  if (response.status === 404) {
    console.log('[AppUpdate] no release endpoint available, treating as no update');
    return null;
  }

  if (!response.ok || typeof response.data !== 'object' || response.data === null) {
    console.log(`[AppUpdate] request failed: status=${response.status}, statusText=${response.statusText}`);
    return null;
  }

  const maybeGitHubRelease = response.data as GitHubReleaseResponse;
  if (typeof maybeGitHubRelease.tag_name === 'string') {
    return parseGitHubReleaseUpdate(maybeGitHubRelease, currentVersion);
  }

  const payload = response.data as UpdateApiResponse;
  if (payload.code !== 0) {
    console.log(`[AppUpdate] server returned error code: ${payload.code}`);
    return null;
  }

  const value = payload.data?.value;
  const latestVersion = value?.version?.trim();
  if (!latestVersion || !isNewerVersion(latestVersion, currentVersion)) {
    console.log(`[AppUpdate] no update available, latestVersion=${latestVersion || 'N/A'}, currentVersion=${currentVersion}`);
    return null;
  }

  const toEntry = (log?: ChangeLogLang): ChangeLogEntry => ({
    title: typeof log?.title === 'string' ? log.title : '',
    content: Array.isArray(log?.content) ? log.content : [],
  });

  const result: AppUpdateInfo = {
    latestVersion,
    date: value?.date?.trim() || '',
    changeLog: {
      zh: toEntry(value?.changeLog?.ch),
      en: toEntry(value?.changeLog?.en),
    },
    url: getPlatformDownloadUrl(value),
  };
  console.log(`[AppUpdate] update available: ${currentVersion} -> ${latestVersion}, downloadUrl=${result.url}`);
  return result;
};
