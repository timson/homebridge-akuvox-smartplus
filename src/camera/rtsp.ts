export type RtspTransport = 'tcp' | 'udp';

export interface StreamSource {
  url: string;
  transport: RtspTransport;
  label: 'local' | 'cloud';
}

/** A locally-reachable RTSP source for a door station, from plugin config. */
export interface LocalCameraConfig {
  mac: string;
  rtspUrl: string;
  rtspTransport?: RtspTransport;
}

export interface CloudRtspSource {
  /** `vrtsp_server`, e.g. "rtspsrv1.ecloud.akuvox.com:8601" (host:port). */
  vrtspServer?: string;
  /** Fallback relay host from `rtmp_server`; RTSP is served on :554 there. */
  relayHost?: string;
  mac: string;
  password: string;
}

/** The cloud relay RTSP URL for a door camera. Prefers vrtsp_server, falls back to the relay host. */
export function buildRtspUrl(source: CloudRtspSource): string | undefined {
  const authority = source.vrtspServer || (source.relayHost ? `${source.relayHost}:554` : undefined);
  if (!authority) return undefined;
  return `rtsp://ak:${encodeURIComponent(source.password)}@${authority}/${source.mac}`;
}

/** The ordered list of stream sources to try: a local RTSP first, then the cloud relay. */
export function buildStreamSources(
  local: { url: string; transport: RtspTransport } | undefined,
  cloudUrl: string | undefined,
): StreamSource[] {
  const sources: StreamSource[] = [];
  if (local?.url) sources.push({ url: local.url, transport: local.transport, label: 'local' });
  if (cloudUrl) sources.push({ url: cloudUrl, transport: 'udp', label: 'cloud' });
  return sources;
}

/** MAC compared without separators or case, so "0C:11:05…" and "0c1105…" match. */
export function normalizeMac(mac: unknown): string {
  return typeof mac === 'string' ? mac.replace(/[^0-9a-z]/gi, '').toLowerCase() : '';
}

/** Config JSON may contain unfinished UI rows; skip them and allow cloud fallback. */
export function findLocalCamera(cameras: unknown, mac: unknown): LocalCameraConfig | undefined {
  const target = normalizeMac(mac);
  if (!target || !Array.isArray(cameras)) return undefined;
  return cameras.find((c): c is LocalCameraConfig => (
    c !== null && typeof c === 'object'
    && typeof c.mac === 'string' && normalizeMac(c.mac) === target
    && typeof c.rtspUrl === 'string' && c.rtspUrl.trim().length > 0
    && (c.rtspTransport === undefined || c.rtspTransport === 'tcp' || c.rtspTransport === 'udp')
  ));
}

/** Hide the RTSP password when a URL is logged, including percent-encoded ones with a query string. */
export function redactRtsp(url: string): string {
  return url.replace(/(rtsp:\/\/[^:/@]+:)[^@]+(@)/i, '$1<redacted>$2');
}
