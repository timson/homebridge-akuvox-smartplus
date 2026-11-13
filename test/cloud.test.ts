import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AkuvoxCloud, normalizePhone } from '../src/akuvox/cloud.js';

const http2 = vi.hoisted(() => ({ body: '', headers: {}, response: {} as Record<string, unknown> }));
vi.mock('node:http2', () => ({
  connect: () => ({
    request: (headers: Record<string, unknown>) => {
      http2.headers = headers;
      const req = new EventEmitter();
      return Object.assign(req, {
        setEncoding: vi.fn(), setTimeout: vi.fn(),
        end: (body: string) => {
          http2.body = body;
          queueMicrotask(() => {
            req.emit('response', { ':status': 200 });
            req.emit('data', JSON.stringify(http2.response));
            req.emit('end');
          });
        },
      });
    },
    close: vi.fn(),
  }),
}));

const fetchMock = vi.fn<typeof fetch>();
const respond = (datas: Record<string, unknown>, envelope = 'result') =>
  fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ [envelope]: envelope === 'result' ? 0 : '0', datas })));

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe('SMS login', () => {
  it('resolves the REST server and sends a normalized phone number without a password', async () => {
    respond({ rest_server_https: 'rest.ecloud.akuvox.com:8443' });
    respond({}, 'err_code');
    const cloud = new AkuvoxCloud('ecloud', '', '');
    await expect(cloud.sendSmsCode('+972', '050-123 4567')).resolves.toBe('rest.ecloud.akuvox.com:8443');
    expect(fetchMock.mock.calls[0]![0]).toBe('https://gate.ecloud.akuvox.com:8600/rest_server');
    expect(fetchMock.mock.calls[0]![1]?.headers).toMatchObject({ 'api-version': '6.0' });
    const [url, init] = fetchMock.mock.calls[1]!;
    expect(url).toBe('https://rest.ecloud.akuvox.com:8443/send_mobile_checkcode');
    expect(init?.method).toBe('POST');
    expect(Object.fromEntries(new URLSearchParams(init?.body as string))).toEqual({ AreaCode: '972', MobileNumber: '501234567', Type: '0' });
    expect(cloud.hasCredentials).toBe(false);
  });

  it('exchanges the code and retrieves regional session and camera endpoints with POST', async () => {
    respond({ token: 'session', auth_token: 'sms-auth', token_valid: 3600 }, 'err_code');
    respond({ rest_server_https: 'account-rest:8443', web_backend_server: 'backend', rtsp_server: 'video:554', pbx_server: 'pbx:5060' });
    const cloud = new AkuvoxCloud('ecloud', '', '');
    const result = await cloud.verifySmsCode('972', '0501234567', '012345', 'discovered-rest:8443');
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe('https://gate.ecloud.akuvox.com:8600/sms_login?phone=834567890&code=012345&area_code=972');
    expect(init?.headers).toMatchObject({ 'api-version': '6.6' });
    expect(fetchMock.mock.calls[1]![0]).toBe('https://gate.ecloud.akuvox.com:8600/servers_list');
    expect(fetchMock.mock.calls[1]![1]).toMatchObject({ method: 'POST', headers: { 'api-version': '6.8', 'x-auth-token': 'session' } });
    expect(JSON.parse(fetchMock.mock.calls[1]![1]?.body as string)).toEqual({ auth_token: 'sms-auth', passwd: 'sms-auth', token: 'session', user: '834567890' });
    expect(result).toMatchObject({ token: 'session', authToken: 'sms-auth', refreshToken: '', tokenValidSeconds: 3600, restServer: 'account-rest:8443', webBackendServer: 'backend', vrtspServer: 'video:554', sipServer: 'pbx:5060' });
  });

  it('uses GET for ucloud server metadata and keeps the discovered REST endpoint', async () => {
    respond({ token: 'session', auth_token: 'sms-auth' });
    respond({ rtsp_server: 'video:554' });
    const result = await new AkuvoxCloud('ucloud', '', '').verifySmsCode('1', '5551234567', '123456', 'rest.ucloud:8443');
    expect(fetchMock.mock.calls[1]![1]?.method).toBe('GET');
    expect(result.restServer).toBe('rest.ucloud:8443');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('uses complete login metadata without another server lookup and normalizes RTSP URLs', async () => {
    respond({ token: 'session', auth_token: 'auth', rtsp_server: 'rtsp://camera:554', pbx_server: 'pbx:5060' });
    const result = await new AkuvoxCloud('ecloud', '', '').verifySmsCode('972', '501234567', '123456', 'rest:8443');
    expect(result).toMatchObject({ vrtspServer: 'camera:554', sipServer: 'pbx:5060', restServer: 'rest:8443' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('falls back to POST if the ucloud GET is rejected', async () => {
    respond({ token: 'session', auth_token: 'sms-auth' });
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ result: 1, message: 'use POST' })));
    respond({ vrtsp_server: 'video:554' });
    await new AkuvoxCloud('ucloud', '', '').verifySmsCode('1', '5551234567', '123456', 'rest:8443');
    expect(fetchMock.mock.calls[2]![1]?.method).toBe('POST');
  });

  it('rejects a failed SMS request', async () => {
    respond({ rest_server_https: 'rest:8443' });
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ result: 1, message: 'rate limited' })));
    await expect(new AkuvoxCloud('ecloud', '', '').sendSmsCode('972', '501234567')).rejects.toThrow('send SMS code failed: rate limited');
  });

  it('rejects an invalid verification code without requesting account endpoints', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ err_code: '1', message: 'invalid code' })));
    await expect(new AkuvoxCloud('ecloud', '', '').verifySmsCode('972', '501234567', 'wrong', 'rest:8443')).rejects.toThrow('SMS login failed: invalid code');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('rejects successful envelopes missing the session credentials', async () => {
    respond({ token: 'session' });
    await expect(new AkuvoxCloud('ecloud', '', '').verifySmsCode('972', '501234567', '123456', 'rest:8443')).rejects.toThrow('no session or auth token');
  });

  it.each([['', '501234567'], ['abc', '501234567'], ['972', '+972501234567'], ['972', '---']])('rejects invalid phone input %s / %s before requesting a code', async (country, number) => {
    await expect(new AkuvoxCloud('ecloud', '', '').sendSmsCode(country, number)).rejects.toThrow('valid country calling code');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('preserves significant leading subscriber digits', () => {
    expect(normalizePhone('+1', '(555) 123-4567')).toEqual({ countryCode: '1', phoneNumber: '5551234567' });
  });
});

describe('token refresh transport', () => {
  it.each(['auth_token', 'refresh_token'] as const)('sends %s over HTTP/2', async (credentialKey) => {
    http2.response = { result: 0, datas: { token: 'new-session' } };
    const cloud = new AkuvoxCloud('ecloud', '', '');
    const result = await cloud.refresh('renewal-secret', 'old-session', credentialKey);
    expect(JSON.parse(http2.body)).toEqual({ [credentialKey]: 'renewal-secret' });
    expect(http2.headers).toMatchObject({ ':method': 'POST', ':path': '/refresh_token', 'x-auth-token': 'old-session', 'api-version': '6.8' });
    expect(result.token).toBe('new-session');
  });

  it.each(['result', 'err_code', 'code'])('accepts numeric and string success codes in %s', async (envelope) => {
    for (const value of [0, '0']) {
      http2.response = { [envelope]: value, datas: { token: 'session' } };
      await expect(new AkuvoxCloud('ecloud', '', '').refresh('auth', 'old', 'auth_token')).resolves.toMatchObject({ token: 'session' });
    }
  });

  it('rejects refresh responses without a token', async () => {
    http2.response = { result: 0, datas: {} };
    await expect(new AkuvoxCloud('ecloud', '', '').refresh('auth', 'old', 'auth_token')).rejects.toThrow('no session token');
  });
});
