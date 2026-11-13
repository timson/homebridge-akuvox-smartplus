import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AkuvoxError, type AkuvoxCloud, type LoginResult } from '../src/akuvox/cloud.js';
import { NotPairedError, SessionManager } from '../src/akuvox/session-manager.js';
import { SessionStore } from '../src/akuvox/session-store.js';

const silent = { info: () => {}, warn: () => {}, error: () => {} };

/** A refresh response carries only a new token and refresh token — no server fields. */
const refreshResult = (token: string): LoginResult => ({
  token,
  refreshToken: `${token}-r`,
  tokenValidSeconds: 604800,
  restServer: undefined as unknown as string,
  raw: {},
});

describe('SessionManager renew', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'akuvox-mgr-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('keeps restServer and calls the API with it after a stale refresh', async () => {
    const store = new SessionStore(dir);
    store.write({ token: 'old', refreshToken: 'old-r', tokenValidSeconds: 604800, restServer: 'rest.example.com', webBackendServer: 'backend.example.com', idCode: 'ID', obtainedAt: '2026-01-01T00:00:00Z' });

    const cloud = {
      refresh: vi.fn(async () => refreshResult('new')),
      listDevices: vi.fn(async () => []),
    } as unknown as AkuvoxCloud;

    const manager = new SessionManager(cloud, store, silent);
    await manager.listDevices();

    expect(cloud.refresh).toHaveBeenCalledWith('old-r', 'old');
    expect(cloud.listDevices).toHaveBeenCalledWith('rest.example.com', 'new');
    expect(store.read()?.restServer).toBe('rest.example.com');
    expect(store.read()?.token).toBe('new');
  });

  it('retries once on an auth error by renewing the token', async () => {
    const store = new SessionStore(dir);
    store.write({ token: 'old', refreshToken: 'old-r', tokenValidSeconds: 604800, restServer: 'rest.example.com', idCode: 'ID', obtainedAt: new Date().toISOString() });

    const listDevices = vi.fn()
      .mockRejectedValueOnce(new AkuvoxError('listDevices failed: expired'));
    const cloud = {
      refresh: vi.fn(async () => refreshResult('new')),
      listDevices,
    } as unknown as AkuvoxCloud;
    // Second call resolves.
    listDevices.mockResolvedValueOnce([]);

    const manager = new SessionManager(cloud, store, silent);
    await expect(manager.listDevices()).resolves.toEqual([]);
    expect(cloud.refresh).toHaveBeenCalledTimes(1);
    expect(listDevices).toHaveBeenCalledTimes(2);
  });

  it.each([undefined, 'rotated-auth'])('renews SMS sessions and preserves or rotates auth_token (%s)', async (authToken) => {
    const store = new SessionStore(dir);
    store.write({ token: 'old', refreshToken: '', authToken: 'sms-auth', tokenValidSeconds: 1, restServer: 'rest.example.com', webBackendServer: 'backend', obtainedAt: '2026-01-01T00:00:00Z' });
    const cloud = {
      refresh: vi.fn(async () => ({ ...refreshResult('new'), refreshToken: '', authToken })),
      listDevices: vi.fn(async () => []),
    } as unknown as AkuvoxCloud;
    await new SessionManager(cloud, store, silent).listDevices();
    expect(cloud.refresh).toHaveBeenCalledWith('sms-auth', 'old', 'auth_token');
    expect(store.read()).toMatchObject({ token: 'new', authToken: authToken ?? 'sms-auth', restServer: 'rest.example.com', webBackendServer: 'backend' });
    const reloaded = new SessionManager(cloud, store, silent);
    await reloaded.listDevices();
    expect(cloud.listDevices).toHaveBeenLastCalledWith('rest.example.com', 'new');
  });

  it('preserves an email refresh credential when only the session token is rotated', async () => {
    const store = new SessionStore(dir);
    store.write({ token: 'old', refreshToken: 'email-refresh', tokenValidSeconds: 1, restServer: 'rest', obtainedAt: '2026-01-01T00:00:00Z' });
    const cloud = { refresh: vi.fn(async () => ({ ...refreshResult('new'), refreshToken: '' })), listDevices: vi.fn(async () => []) } as unknown as AkuvoxCloud;
    await new SessionManager(cloud, store, silent).listDevices();
    expect(store.read()?.refreshToken).toBe('email-refresh');
  });

  it('requires SMS pairing again if renewal fails instead of using an old password', async () => {
    const store = new SessionStore(dir);
    store.write({ token: 'old', refreshToken: '', authToken: 'sms-auth', idCode: 'old-email-id', tokenValidSeconds: 1, restServer: 'rest', obtainedAt: '2026-01-01T00:00:00Z' });
    const cloud = { refresh: vi.fn().mockRejectedValue(new AkuvoxError('expired')), hasCredentials: true, reloginWithIdCode: vi.fn() } as unknown as AkuvoxCloud;
    await expect(new SessionManager(cloud, store, silent).listDevices()).rejects.toBeInstanceOf(NotPairedError);
    expect(cloud.reloginWithIdCode).not.toHaveBeenCalled();
  });

  it('replaces the previous account metadata when pairing another account', () => {
    const store = new SessionStore(dir);
    store.write({ token: 'old', refreshToken: '', authToken: 'sms-auth', tokenValidSeconds: 1, restServer: 'old-rest', sipUser: 'old-sip', obtainedAt: '2026-01-01T00:00:00Z' });
    const manager = new SessionManager({} as AkuvoxCloud, store, silent);
    manager.adopt({ ...refreshResult('new'), restServer: 'new-rest' }, undefined, undefined, true);
    expect(store.read()?.authToken).toBeUndefined();
    expect(store.read()?.sipUser).toBeUndefined();
  });
});
