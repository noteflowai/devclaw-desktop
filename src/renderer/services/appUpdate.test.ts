import { beforeEach, expect, test, vi } from 'vitest';
import { checkForAppUpdate } from './appUpdate';

beforeEach(() => {
  vi.restoreAllMocks();
  vi.stubGlobal('window', {
    electron: {
      platform: 'win32',
      arch: 'x64',
      api: {
        fetch: vi.fn(),
      },
    },
  });
});

test('checkForAppUpdate treats missing GitHub latest release as no update', async () => {
  const fetchMock = window.electron.api.fetch as ReturnType<typeof vi.fn>;
  fetchMock.mockResolvedValue({
    ok: false,
    status: 404,
    statusText: 'Not Found',
    headers: {},
    data: { message: 'Not Found' },
  });

  await expect(checkForAppUpdate('2026.6.1-preview.1')).resolves.toBeNull();
  expect(fetchMock).toHaveBeenCalledWith(expect.objectContaining({
    expectedStatuses: [404],
  }));
});

