import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CredentialsStore, SessionStore } from '../src/akuvox/session-store.js';

const input = vi.hoisted(() => ({ home: '', question: vi.fn(), close: vi.fn() }));
vi.mock('node:readline/promises', () => ({ createInterface: () => input }));
vi.mock('node:os', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:os')>(),
  homedir: () => input.home,
}));

const fetchMock = vi.fn<typeof fetch>();
const respond = (datas: Record<string, unknown>) =>
  fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ result: 0, datas })));
const originalArgv = process.argv;
let dir: string;
const configure = (config: Record<string, unknown>) => writeFileSync(join(dir, 'config.json'), JSON.stringify({
  platforms: [{ platform: 'AkuvoxSmartPlus', region: 'ecloud', ...config }],
}));
const accountData = () => {
  respond({ app_conf: { sip: 'sip-user', sip_passwd: 'sip-password', sip_server: 'pbx:5060' } });
  respond({ dev_list: [] });
};

beforeEach(() => {
  vi.resetModules();
  dir = mkdtempSync(join(tmpdir(), 'akuvox-pair-'));
  input.home = dir;
  input.question.mockReset();
  input.close.mockReset();
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  process.argv = ['node', 'akuvox-pair', '-U', dir];
});
afterEach(() => {
  process.argv = originalArgv;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

describe('akuvox-pair', () => {
  it('pairs with configured SMS defaults, clears an old password, and saves a renewable session', async () => {
    configure({ authMethod: 'sms', countryCode: '972', phoneNumber: '0501234567', email: 'old@example.com', password: 'old-password' });
    new CredentialsStore(dir).write({ email: 'old@example.com', password: 'old-password' });
    input.question.mockResolvedValueOnce('012345');
    respond({ rest_server_https: 'rest:8443' });
    respond({});
    respond({ token: 'sms-session', auth_token: 'sms-refresh', token_valid: 3600 });
    respond({ vrtsp_server: 'camera:554', web_backend_server: 'backend' });
    accountData();

    await import('../src/pair.js');

    expect(input.question.mock.calls).toEqual([['Enter the verification code received by SMS: ']]);
    expect(input.close).toHaveBeenCalledOnce();
    expect(new SessionStore(dir).read()).toMatchObject({ token: 'sms-session', authToken: 'sms-refresh', restServer: 'rest:8443', vrtspServer: 'camera:554', sipUser: 'sip-user', sipServer: 'pbx:5060' });
    expect(new CredentialsStore(dir).read()).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(6);
  });

  it('lets --sms override email settings and prompts for the phone and code', async () => {
    configure({ authMethod: 'email', email: 'email@example.com', password: 'pw' });
    process.argv.push('--sms');
    input.question.mockResolvedValueOnce('+972').mockResolvedValueOnce('0501234567').mockResolvedValueOnce('123456');
    respond({ rest_server_https: 'rest:8443' });
    respond({});
    respond({ token: 'session', auth_token: 'auth' });
    respond({ vrtsp_server: 'camera:554' });
    accountData();

    await import('../src/pair.js');

    expect(input.question.mock.calls.map(([prompt]) => prompt)).toEqual([
      'Country calling code (e.g. 972): ',
      'SmartPlus local phone number (without country code): ',
      'Enter the verification code received by SMS: ',
    ]);
    expect(fetchMock.mock.calls[2]![0]).toContain('phone=3834567890');
  });

  it.each([
    { stripLeadingZero: false, flags: [], number: '0501234567', shifted: '3834567890' },
    { stripLeadingZero: true, flags: [], number: '501234567', shifted: '834567890' },
    { stripLeadingZero: false, flags: ['--strip-leading-zero'], number: '501234567', shifted: '834567890' },
    { stripLeadingZero: true, flags: ['--keep-leading-zero'], number: '0501234567', shifted: '3834567890' },
  ])('uses a consistent phone format through SMS pairing: $number ($flags)', async ({ stripLeadingZero, flags, number, shifted }) => {
    configure({ authMethod: 'sms', countryCode: '972', phoneNumber: '0501234567', stripLeadingZero });
    process.argv.push(...flags);
    input.question.mockResolvedValueOnce('123456');
    respond({ rest_server_https: 'rest:8443' });
    respond({});
    respond({ token: 'session', auth_token: 'auth' });
    respond({ vrtsp_server: 'camera:554' });
    accountData();
    await import('../src/pair.js');
    expect(new URLSearchParams(fetchMock.mock.calls[1]![1]?.body as string).get('MobileNumber')).toBe(number);
    expect(new URL(String(fetchMock.mock.calls[2]![0])).searchParams.get('phone')).toBe(shifted);
    expect(JSON.parse(fetchMock.mock.calls[3]![1]?.body as string).user).toBe(shifted);
  });

  it('removes at most one leading zero across all pairing steps', async () => {
    configure({ authMethod: 'sms', countryCode: '972', phoneNumber: '00501234567', stripLeadingZero: true });
    input.question.mockResolvedValueOnce('123456');
    respond({ rest_server_https: 'rest:8443' });
    respond({});
    respond({ token: 'session', auth_token: 'auth' });
    respond({ vrtsp_server: 'camera:554' });
    accountData();
    await import('../src/pair.js');
    expect(new URLSearchParams(fetchMock.mock.calls[1]![1]?.body as string).get('MobileNumber')).toBe('0501234567');
    expect(new URL(String(fetchMock.mock.calls[2]![0])).searchParams.get('phone')).toBe('3834567890');
  });

  it('rejects contradictory phone format flags before sending an SMS', async () => {
    configure({ authMethod: 'sms' });
    process.argv.push('--strip-leading-zero', '--keep-leading-zero');
    await expect(import('../src/pair.js')).rejects.toThrow('Choose only one');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(input.close).toHaveBeenCalledOnce();
  });

  it('uses SMS when configured even when a legacy email credentials file exists', async () => {
    mkdirSync(join(dir, '.akuvox'));
    writeFileSync(join(dir, '.akuvox', 'credentials'), 'legacy@example.com\npassword');
    configure({ authMethod: 'sms', countryCode: '972', phoneNumber: '501234567' });
    input.question.mockResolvedValueOnce('123456');
    respond({ rest_server_https: 'rest:8443' });
    respond({});
    respond({ token: 'session', auth_token: 'auth' });
    respond({ vrtsp_server: 'camera:554' });
    accountData();
    await import('../src/pair.js');
    expect(new CredentialsStore(dir).read()).toBeUndefined();
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/login?'))).toBe(false);
  });

  it('offers SMS interactively and prompts for blank optional phone settings', async () => {
    configure({ countryCode: '', phoneNumber: '' });
    input.question.mockResolvedValueOnce('sms').mockResolvedValueOnce('972').mockResolvedValueOnce('501234567').mockResolvedValueOnce('123456');
    respond({ rest_server_https: 'rest:8443' });
    respond({});
    respond({ token: 'session', auth_token: 'auth' });
    respond({ vrtsp_server: 'camera:554' });
    accountData();
    await import('../src/pair.js');
    expect(input.question).toHaveBeenCalledTimes(4);
    expect(input.question).toHaveBeenNthCalledWith(1, 'Sign-in method (email/sms) [email]: ');
    expect(new SessionStore(dir).read()?.authToken).toBe('auth');
  });

  it('keeps email/password pairing and its email verification challenge working', async () => {
    configure({ email: 'email@example.com', password: 'pw' });
    input.question.mockResolvedValueOnce('123456');
    respond({ is_need_two_factor_auth: 1, two_factor_auth_temp_token: 'temporary', rest_server_https: 'rest:8443' });
    respond({});
    respond({ token: 'email-session', refresh_token: 'email-refresh', rest_server_https: 'rest:8443' });
    accountData();

    await import('../src/pair.js');

    expect(input.question.mock.calls).toEqual([['Enter the verification code emailed to the account: ']]);
    expect(new SessionStore(dir).read()).toMatchObject({ token: 'email-session', refreshToken: 'email-refresh' });
    expect(new CredentialsStore(dir).read()).toEqual({ email: 'email@example.com', password: 'pw' });
  });

  it('closes the prompt and keeps the previous credentials if SMS verification fails', async () => {
    configure({ authMethod: 'sms', countryCode: '972', phoneNumber: '501234567' });
    const credentials = { email: 'old@example.com', password: 'old-password' };
    new CredentialsStore(dir).write(credentials);
    input.question.mockResolvedValueOnce('wrong');
    respond({ rest_server_https: 'rest:8443' });
    respond({});
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ result: 1, message: 'wrong code' })));

    await expect(import('../src/pair.js')).rejects.toThrow('SMS login failed');

    expect(input.close).toHaveBeenCalledOnce();
    expect(new CredentialsStore(dir).read()).toEqual(credentials);
    expect(new SessionStore(dir).read()).toBeUndefined();
  });
});
