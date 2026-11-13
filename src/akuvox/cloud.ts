import { connect as http2Connect } from 'node:http2';
import type { Region } from '../settings.js';
import { caesarShift, hashPassword, loginUserParam } from './crypto.js';
import type { AkuvoxDevice, DoorLogEntry, Envelope } from './types.js';

const USER_AGENT = 'VBell/7.51.3 (iPad; iOS 26.6; Scale/2.00)';
const REQUEST_TIMEOUT_MS = 15_000;

export class AkuvoxError extends Error {}

export interface LoginChallenge {
  needsTwoFactor: boolean;
  tempToken?: string;
  restServer: string;
  webBackendServer?: string;
  /** Present when the account skipped two-factor and the token came back directly. */
  result?: LoginResult;
  raw: Envelope;
}

export interface LoginResult {
  token: string;
  refreshToken: string;
  authToken?: string;
  tokenValidSeconds: number;
  idCode?: string;
  restServer: string;
  webBackendServer?: string;
  rtspRelay?: string;
  vrtspServer?: string;
  sipServer?: string;
  raw: Envelope;
}

const isSuccess = (e: Envelope): boolean => [e.result, e.err_code, e.code].some((code) => code === 0 || code === '0');
const payload = (e: Envelope): Envelope => (e.datas ?? e.data ?? e) as Envelope;

/** Strip formatting, preserving subscriber digits unless removal is explicitly requested. */
export function normalizePhone(countryCode: string, phoneNumber: string, stripLeadingZero = false): { countryCode: string; phoneNumber: string } {
  const country = countryCode.trim().replace(/^\+/, '');
  const digits = phoneNumber.trim().replace(/[\s()-]/g, '');
  const number = stripLeadingZero ? digits.replace(/^0/, '') : digits;
  if (!/^[1-9]\d{0,2}$/.test(country) || !/^\d+$/.test(number)) {
    throw new AkuvoxError('Enter a valid country calling code and local phone number (without the country code)');
  }
  return { countryCode: country, phoneNumber: number };
}

function rtspAuthority(server: unknown): string | undefined {
  if (typeof server !== 'string' || !server.trim()) return undefined;
  try {
    return new URL(server.includes('://') ? server : `rtsp://${server}`).host || undefined;
  } catch {
    return undefined;
  }
}

export function parseLoginResult(d: Envelope): LoginResult {
  return {
    token: d.token as string,
    refreshToken: (d.refresh_token ?? '') as string,
    authToken: d.auth_token as string | undefined,
    tokenValidSeconds: Number(d.token_valid ?? 0),
    idCode: d.two_factor_auth_idcode as string | undefined,
    restServer: d.rest_server_https as string,
    webBackendServer: d.web_backend_server as string | undefined,
    rtspRelay: (d.rtmp_server as string | undefined)?.split(':')[0],
    vrtspServer: rtspAuthority(d.rtsp_server) ?? d.vrtsp_server as string | undefined,
    sipServer: d.pbx_server as string | undefined,
    raw: d,
  };
}

export class AkuvoxCloud {
  private readonly gate: string;

  constructor(
    private readonly region: Region,
    private readonly user: string,
    private readonly password: string,
  ) {
    this.gate = `https://gate.${region}.akuvox.com:8600`;
  }

  /** Whether login/re-login is possible; refresh works without these. */
  get hasCredentials(): boolean {
    return this.user.length > 0 && this.password.length > 0;
  }

  /** Step 1: submit credentials. Returns whether an emailed code is still required. */
  async login(idCode?: string): Promise<LoginChallenge> {
    const idCodeQuery = idCode ? `&id_code=${encodeURIComponent(idCode)}` : '';
    const e = await this.get(`${this.gate}/login?user=${loginUserParam(this.user)}&passwd=${hashPassword(this.password)}${idCodeQuery}`, '7.33');
    this.assert(e, 'login');
    const d = payload(e);
    return {
      needsTwoFactor: String(d.is_need_two_factor_auth) === '1',
      tempToken: d.two_factor_auth_temp_token as string | undefined,
      restServer: d.rest_server_https as string,
      webBackendServer: d.web_backend_server as string | undefined,
      result: d.token ? parseLoginResult(d) : undefined,
      raw: d,
    };
  }

  /** Step 2a: ask the cloud to email a verification code. */
  async sendTwoFactorCode(restServer: string, tempToken: string): Promise<void> {
    const e = await this.post(
      `https://${restServer}/apprest/v2/send_two_factor_authentication_code`,
      '7.1',
      new URLSearchParams({ account_type: 'enduser', login_account: this.user, two_factor_auth_temp_token: tempToken }).toString(),
      'application/x-www-form-urlencoded',
    );
    this.assert(e, 'send two-factor code');
  }

  /** Step 2b: exchange the emailed code for a session token. */
  async verifyTwoFactorCode(code: string): Promise<LoginResult> {
    const e = await this.post(`${this.gate}/enduser/enduser_verify_code`, '7.33', JSON.stringify({ verify_code: code, user: this.user }), 'application/json');
    this.assert(e, 'verify code');
    return parseLoginResult(payload(e));
  }

  /** Resolve the regional REST endpoint and request a passwordless SMS sign-in code. */
  async sendSmsCode(countryCode: string, phoneNumber: string): Promise<string> {
    const phone = normalizePhone(countryCode, phoneNumber);
    const servers = await this.get(`${this.gate}/rest_server`, '6.0');
    this.assert(servers, 'resolve REST server');
    const restServer = payload(servers).rest_server_https as string;
    if (!restServer) throw new AkuvoxError('REST server lookup returned no endpoint');
    const e = await this.post(
      `https://${restServer}/send_mobile_checkcode`,
      '',
      new URLSearchParams({ AreaCode: phone.countryCode, MobileNumber: phone.phoneNumber, Type: '0' }).toString(),
      'application/x-www-form-urlencoded',
    );
    this.assert(e, 'send SMS code');
    return restServer;
  }

  /** Exchange the SMS code, then retrieve endpoints omitted by sms_login. */
  async verifySmsCode(countryCode: string, phoneNumber: string, code: string, restServer: string): Promise<LoginResult> {
    const phone = normalizePhone(countryCode, phoneNumber);
    if (!code.trim()) throw new AkuvoxError('Enter the SMS verification code');
    const query = new URLSearchParams({ phone: caesarShift(phone.phoneNumber), code: code.trim(), area_code: phone.countryCode });
    const e = await this.get(`${this.gate}/sms_login?${query}`, '6.6');
    this.assert(e, 'SMS login');
    const d = payload(e);
    if (!d.token || !d.auth_token) throw new AkuvoxError('SMS login returned no session or auth token');
    if (d.rtsp_server || d.vrtsp_server || d.rtmp_server) {
      return parseLoginResult({ rest_server_https: restServer, ...d });
    }

    let servers: Envelope | undefined;
    // The reference integration uses GET only in ucloud; other regions require POST.
    if (this.region === 'ucloud') {
      try {
        const response = await this.get(`${this.gate}/servers_list`, '6.8', d.token as string);
        this.assert(response, 'servers_list');
        const data = payload(response);
        if (data.rtsp_server || data.vrtsp_server || data.rtmp_server) servers = data;
      } catch {
        // Fall back to the POST variant below.
      }
    }
    if (!servers) {
      const response = await this.post(`${this.gate}/servers_list`, '6.8', JSON.stringify({
        auth_token: d.auth_token, passwd: d.auth_token, token: d.token, user: caesarShift(phone.phoneNumber),
      }), 'application/json', d.token as string);
      this.assert(response, 'servers_list');
      servers = payload(response);
    }
    return parseLoginResult({ rest_server_https: restServer, ...servers, ...d });
  }

  /** Renew the token without re-login; the previous token is invalidated. */
  async refresh(refreshToken: string, token: string, credentialKey: 'refresh_token' | 'auth_token' = 'refresh_token'): Promise<LoginResult> {
    const e = await this.postHttp2(`${this.gate}/refresh_token`, '6.8', { [credentialKey]: refreshToken }, token);
    this.assert(e, 'refresh token');
    const d = payload(e);
    if (!d.token) throw new AkuvoxError('Token refresh returned no session token');
    return parseLoginResult(d);
  }

  /** Re-login on a trusted device, skipping the emailed code. */
  async reloginWithIdCode(idCode: string): Promise<LoginResult> {
    const e = await this.get(`${this.gate}/login?user=${loginUserParam(this.user)}&passwd=${hashPassword(this.password)}&id_code=${encodeURIComponent(idCode)}`, '7.33');
    this.assert(e, 're-login');
    const d = payload(e);
    if (!d.token) throw new AkuvoxError('re-login did not return a token; an emailed code is required');
    return parseLoginResult(d);
  }

  async listDevices(restServer: string, token: string): Promise<AkuvoxDevice[]> {
    const e = await this.get(`https://${restServer}/userconf?token=${token}`, '7.13', token);
    this.assert(e, 'userconf');
    const list = (payload(e).dev_list as Envelope[] | undefined) ?? [];
    return list.map((d) => ({
      mac: d.mac as string,
      location: d.location as string,
      devType: String(d.dev_type),
      sip: d.sip as string | undefined,
      rtspPassword: d.rtsp_pwd as string | undefined,
      cameraCount: Number(d.camera_num ?? 0),
      relays: ((d.relay as Envelope[] | undefined) ?? []).map((r) => ({
        relayId: r.relay_id as string,
        doorName: r.door_name as string,
        enabled: String(r.enable) === '1',
      })),
    }));
  }

  async getSipConfig(restServer: string, token: string): Promise<{ sipUser: string; sipPassword: string; sipServer?: string } | undefined> {
    const e = await this.get(`https://${restServer}/userconf?token=${token}`, '7.13', token);
    this.assert(e, 'userconf');
    const app = payload(e).app_conf as Envelope | undefined;
    if (!app?.sip || !app?.sip_passwd) return undefined;
    return { sipUser: app.sip as string, sipPassword: app.sip_passwd as string, sipServer: app.sip_server as string | undefined };
  }

  async getSipServer(token: string): Promise<string | undefined> {
    const e = await this.get(`${this.gate}/servers_list`, '6.8', token);
    this.assert(e, 'servers_list');
    return payload(e).pbx_server as string | undefined;
  }

  async openDoor(restServer: string, token: string, mac: string, relayId: string): Promise<void> {
    const traceId = Math.random().toString(16).slice(2, 13).padEnd(22, '0');
    const e = await this.post(
      `https://${restServer}/opendoor?token=${token}`,
      '7.1',
      new URLSearchParams({ mac, relay: relayId, trace_id: traceId }).toString(),
      'application/x-www-form-urlencoded',
      token,
    );
    this.assert(e, 'opendoor');
  }

  async getDoorLog(webBackendServer: string, token: string, rows = 5): Promise<DoorLogEntry[]> {
    const url = `https://${webBackendServer}/web-server/v4/smartplus/community/log/member/getDoorLog?row=${rows}&page=1&_t=${Date.now()}`;
    const e = await this.get(url, '6.4', token, { 'x-cloud-version': '6.4', 'x-cloud-lang': 'en', Origin: `https://${this.region}.akuvox.com`, Referer: `https://${this.region}.akuvox.com/` });
    this.assert(e, 'getDoorLog');
    return ((payload(e).list as Envelope[] | undefined) ?? []).map((r) => ({
      id: r.id as string,
      captureTime: r.captureTime as string,
      captureType: r.captureType as string,
      response: r.response as string,
      relayName: r.relayName as string,
      initiator: r.initiator as string,
      picUrl: r.picUrl as string | undefined,
    }));
  }

  private assert(e: Envelope, what: string): void {
    if (!isSuccess(e)) throw new AkuvoxError(`${what} failed: ${String(e.message ?? e.msg ?? 'unknown error')} (${String(e.result ?? e.err_code ?? e.code)})`);
  }

  private async get(url: string, apiVersion: string, token = '', extra: Record<string, string> = {}): Promise<Envelope> {
    return this.fetchJson(url, { method: 'GET', headers: this.headers(apiVersion, token, extra) });
  }

  private async post(url: string, apiVersion: string, body: string, contentType: string, token = ''): Promise<Envelope> {
    return this.fetchJson(url, { method: 'POST', headers: { ...this.headers(apiVersion, token), 'Content-Type': contentType }, body });
  }

  private headers(apiVersion: string, token: string, extra: Record<string, string> = {}): Record<string, string> {
    return { ...(apiVersion ? { 'api-version': apiVersion } : {}), 'User-Agent': USER_AGENT, 'x-auth-token': token, 'Accept-Language': 'en', Accept: '*/*', ...extra };
  }

  private async fetchJson(url: string, init: RequestInit): Promise<Envelope> {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    const text = await res.text();
    try {
      return JSON.parse(text) as Envelope;
    } catch {
      throw new AkuvoxError(`HTTP ${res.status} non-JSON from ${new URL(url).pathname}: ${text.length <= 80 ? JSON.stringify(text) : `${text.length} bytes`}`);
    }
  }

  /** `refresh_token` is served only over HTTP/2; `fetch` here speaks HTTP/1.1. */
  private postHttp2(url: string, apiVersion: string, body: unknown, token: string): Promise<Envelope> {
    const target = new URL(url);
    const client = http2Connect(target.origin);
    return new Promise<Envelope>((resolve, reject) => {
      const req = client.request({
        ':method': 'POST',
        ':path': target.pathname + target.search,
        'api-version': apiVersion,
        'user-agent': USER_AGENT,
        'content-type': 'application/json',
        'x-auth-token': token,
        accept: '*/*',
      });
      let text = '';
      let status = 0;
      req.setEncoding('utf8');
      req.setTimeout(REQUEST_TIMEOUT_MS, () => req.close());
      req.on('response', (h) => (status = Number(h[':status'])));
      req.on('data', (chunk: string) => (text += chunk));
      req.on('error', reject);
      req.on('end', () => {
        try {
          resolve(JSON.parse(text) as Envelope);
        } catch {
          reject(new AkuvoxError(`HTTP/2 ${status} non-JSON from ${target.pathname}: ${text.length <= 80 ? JSON.stringify(text) : `${text.length} bytes`}`));
        }
      });
      req.end(JSON.stringify(body));
    }).finally(() => client.close());
  }
}
