import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AUTO_UPDATE_COOLDOWN_MS,
  GITHUB_RELEASES_API_URL,
  GITHUB_RELEASES_PAGE_URL,
  UPDATE_CACHE_STORAGE_KEY,
  checkForAppUpdates,
  compareVersions,
  evaluateReleaseCheck,
  extractAndroidVersionCode,
  extractExpectedSha256,
  isCachedUpdateStillNewer,
  openReleaseExternalUrl,
  pickPlatformDownload,
  readUpdateCache,
  sanitizeGitHubReleasePayload,
  shouldRunAutoUpdateCheck,
  shouldShowUpdateBanner,
  validateReleaseExternalUrl,
  writeUpdateCache,
} from '../src/services/appUpdate';

test('compareVersions handles semver, v-prefix, trial suffix matching, and pre-releases', () => {
  assert.equal(compareVersions('v5.1.0', '5.1.0-trial'), 0);
  assert.equal(compareVersions('5.1.0-trial', '5.1.0'), 0);
  assert.equal(compareVersions('v5.2.0', '5.1.0-trial'), 1);
  assert.equal(compareVersions('v5.1.1', '5.1.0'), 1);
  assert.equal(compareVersions('v5.0.9', '5.1.0'), -1);
  assert.equal(compareVersions('5.2.0-beta.2', '5.2.0-beta.1'), 1);
  assert.equal(compareVersions('5.2.0', '5.2.0-rc.1'), 1);
});

test('validateReleaseExternalUrl allows only HTTPS URLs under jizhaoyu/personal-agent or GitHub release asset hosts', () => {
  assert.equal(
    validateReleaseExternalUrl('https://github.com/jizhaoyu/personal-agent/releases/tag/v5.2.0'),
    'https://github.com/jizhaoyu/personal-agent/releases/tag/v5.2.0',
  );
  assert.equal(
    validateReleaseExternalUrl('https://objects.githubusercontent.com/github-production-release-asset-123/Looma.apk'),
    'https://objects.githubusercontent.com/github-production-release-asset-123/Looma.apk',
  );
  for (const unsafe of [
    'http://github.com/jizhaoyu/personal-agent/releases',
    'https://github.com/evil/personal-agent/releases',
    'https://github.com/jizhaoyu/personal-agent.evil.test/releases',
    'https://user:pass@github.com/jizhaoyu/personal-agent/releases',
    'javascript:alert(1)',
    'file:///C:/Windows/System32/calc.exe',
  ]) {
    assert.equal(validateReleaseExternalUrl(unsafe), null, unsafe);
  }
});

test('evaluateReleaseCheck detects Android & Desktop updates, checksums, assets, and versionCode bumps', () => {
  const apkSha = 'a'.repeat(64);
  const winSha = 'b'.repeat(64);
  const release = sanitizeGitHubReleasePayload({
    tag_name: 'v5.2.0',
    name: 'Looma 5.2.0',
    published_at: '2026-11-20T08:00:00Z',
    html_url: 'https://github.com/jizhaoyu/personal-agent/releases/tag/v5.2.0',
    body: [
      '修复备份导入稳定性并优化提醒。',
      'androidVersionCode: 520',
      `${apkSha}  Looma-v5.2.0-release-signed.apk`,
      `${winSha}  Looma-5.2.0-win32-x64.zip`,
    ].join('\n'),
    prerelease: false,
    assets: [
      {
        name: 'Looma-v5.2.0-release-signed.apk',
        browser_download_url: 'https://github.com/jizhaoyu/personal-agent/releases/download/v5.2.0/Looma-v5.2.0-release-signed.apk',
        size: 390000,
      },
      {
        name: 'Looma-5.2.0-win32-x64.zip',
        browser_download_url: 'https://github.com/jizhaoyu/personal-agent/releases/download/v5.2.0/Looma-5.2.0-win32-x64.zip',
        size: 120000000,
      },
    ],
  });

  assert.equal(extractAndroidVersionCode(release.body), 520);
  assert.equal(extractExpectedSha256(release.body, 'Looma-v5.2.0-release-signed.apk', 'android'), apkSha);
  assert.equal(pickPlatformDownload(release, 'android').assetName, 'Looma-v5.2.0-release-signed.apk');
  assert.equal(pickPlatformDownload(release, 'desktop').assetName, 'Looma-5.2.0-win32-x64.zip');

  const androidUpdate = evaluateReleaseCheck(
    { status: 'ok', httpStatus: 200, release },
    { platform: 'android', currentVersion: '5.1.0', currentAndroidVersionCode: 510 },
  );
  assert.equal(androidUpdate.outcome, 'update-available');
  assert.equal(androidUpdate.latestVersion, 'v5.2.0');
  assert.equal(androidUpdate.latestVersionCode, 520);
  assert.equal(androidUpdate.assetName, 'Looma-v5.2.0-release-signed.apk');
  assert.equal(androidUpdate.expectedSha256, apkSha);
  assert.match(androidUpdate.notesSummary || '', /修复备份导入稳定性/);

  const desktopUpToDate = evaluateReleaseCheck(
    { status: 'ok', httpStatus: 200, release },
    { platform: 'desktop', currentVersion: '5.2.0-trial' },
  );
  assert.equal(desktopUpToDate.outcome, 'up-to-date');

  const androidCodeOnlyUpdate = evaluateReleaseCheck(
    { status: 'ok', httpStatus: 200, release: { ...release, tagName: 'v5.1.0' } },
    { platform: 'android', currentVersion: '5.1.0', currentAndroidVersionCode: 510 },
  );
  assert.equal(androidCodeOnlyUpdate.outcome, 'update-available');
});

test('checkForAppUpdates handles GitHub 404 no-release, 429 rate-limit, bridge usage, and unsafe URL denial', async () => {
  const noRelease = await checkForAppUpdates({
    platform: 'desktop',
    currentVersion: '5.1.0-trial',
    fetchImpl: async url => {
      assert.equal(url, GITHUB_RELEASES_API_URL);
      return new Response('{"message":"Not Found"}', { status: 404 });
    },
  });
  assert.equal(noRelease.outcome, 'no-release');
  assert.equal(noRelease.releaseUrl, GITHUB_RELEASES_PAGE_URL);

  const limited = await checkForAppUpdates({
    platform: 'android',
    currentVersion: '5.1.0',
    currentAndroidVersionCode: 510,
    electronAPI: {
      minimizeWindow: async () => {},
      closeWindow: async () => {},
      resizeWindow: async () => {},
      setAlwaysOnTop: async () => false,
      modelStatus: async () => ({ configured: false, persistent: false, enabled: false, apiBaseUrl: '', modelName: '' }),
      migrateLegacyConnection: async () => ({ migrated: false }),
      saveModelConnection: async c => ({ ...c, configured: false, persistent: false }),
      clearModelConnection: async () => {},
      proposeModel: async () => ({ content: '' }),
      captureAgentModel: async () => ({ content: '' }),
      cancelModel: async () => {},
      notifyDue: async () => ({ shown: false }),
      checkForUpdates: async () => ({ status: 'rate-limited', httpStatus: 429 }),
    },
  });
  assert.equal(limited.outcome, 'rate-limited');

  const opened = [];
  const bridge = {
    minimizeWindow: async () => {},
    closeWindow: async () => {},
    resizeWindow: async () => {},
    setAlwaysOnTop: async () => false,
    modelStatus: async () => ({ configured: false, persistent: false, enabled: false, apiBaseUrl: '', modelName: '' }),
    migrateLegacyConnection: async () => ({ migrated: false }),
    saveModelConnection: async c => ({ ...c, configured: false, persistent: false }),
    clearModelConnection: async () => {},
    proposeModel: async () => ({ content: '' }),
    captureAgentModel: async () => ({ content: '' }),
    cancelModel: async () => {},
    notifyDue: async () => ({ shown: false }),
    openExternalUrl: async url => { opened.push(url); return { opened: true, url }; },
  };
  assert.equal(await openReleaseExternalUrl('https://evil.example/payload.exe', bridge), false);
  assert.equal(opened.length, 0);
  assert.equal(await openReleaseExternalUrl(GITHUB_RELEASES_PAGE_URL, bridge), true);
  assert.deepEqual(opened, [GITHUB_RELEASES_PAGE_URL]);
});

test('auto-update cache validates URLs, enforces 12h cooldown, respects offline/webdriver guards, and expires on upgrade', () => {
  const store = new Map<string, string>();
  const mockStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => { store.set(key, value); },
  };

  assert.equal(readUpdateCache(mockStorage), null);
  store.set(UPDATE_CACHE_STORAGE_KEY, '{bad json');
  assert.equal(readUpdateCache(mockStorage), null);

  const sampleResult = evaluateReleaseCheck(
    {
      status: 'ok',
      httpStatus: 200,
      release: sanitizeGitHubReleasePayload({
        tag_name: 'v5.3.0',
        name: 'Looma v5.3.0',
        published_at: '2026-11-20T08:00:00Z',
        html_url: 'https://github.com/jizhaoyu/personal-agent/releases/tag/v5.3.0',
        body: 'androidVersionCode: 530',
        prerelease: false,
        assets: [],
      }),
    },
    { platform: 'android', currentVersion: '5.2.1', currentAndroidVersionCode: 521 },
  );

  const t0 = 1_700_000_000_000;
  writeUpdateCache({ lastCheckedAt: t0, dismissedVersion: 'v5.2.9', latestAvailable: sampleResult }, mockStorage);
  const loaded = readUpdateCache(mockStorage);
  assert.equal(loaded?.lastCheckedAt, t0);
  assert.equal(loaded?.dismissedVersion, 'v5.2.9');
  assert.equal(loaded?.latestAvailable?.latestVersion, 'v5.3.0');

  assert.equal(shouldRunAutoUpdateCheck({ now: t0 + 1000, cache: loaded, isAutomation: false, online: true }), false);
  assert.equal(
    shouldRunAutoUpdateCheck({ now: t0 + AUTO_UPDATE_COOLDOWN_MS - 1, cache: loaded, isAutomation: false, online: true }),
    false,
  );
  assert.equal(
    shouldRunAutoUpdateCheck({ now: t0 + AUTO_UPDATE_COOLDOWN_MS, cache: loaded, isAutomation: false, online: true }),
    true,
  );
  assert.equal(
    shouldRunAutoUpdateCheck({ now: t0 + AUTO_UPDATE_COOLDOWN_MS, cache: null, isAutomation: true, online: true }),
    false,
  );
  assert.equal(
    shouldRunAutoUpdateCheck({ now: t0 + AUTO_UPDATE_COOLDOWN_MS, cache: null, isAutomation: false, online: false }),
    false,
  );

  assert.equal(shouldShowUpdateBanner(sampleResult, 'v5.2.9'), true);
  assert.equal(shouldShowUpdateBanner(sampleResult, 'v5.3.0'), false);

  assert.equal(
    isCachedUpdateStillNewer(loaded?.latestAvailable, {
      platform: 'android',
      currentVersion: '5.2.1',
      currentAndroidVersionCode: 521,
    }),
    true,
  );
  assert.equal(
    isCachedUpdateStillNewer(loaded?.latestAvailable, {
      platform: 'android',
      currentVersion: '5.3.0',
      currentAndroidVersionCode: 530,
    }),
    false,
  );

  store.set(UPDATE_CACHE_STORAGE_KEY, JSON.stringify({
    lastCheckedAt: t0,
    latestAvailable: {
      ...sampleResult,
      releaseUrl: 'https://evil.example/phish',
      downloadUrl: 'https://evil.example/payload.exe',
    },
  }));
  assert.equal(readUpdateCache(mockStorage)?.latestAvailable, null);
});
