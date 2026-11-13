#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { AkuvoxCloud, normalizePhone, type LoginResult } from './akuvox/cloud.js';
import { SessionManager } from './akuvox/session-manager.js';
import { CredentialsStore, SessionStore } from './akuvox/session-store.js';
import type { AuthMethod, Region } from './settings.js';
import { PLATFORM_NAME, REGIONS } from './settings.js';

interface PlatformBlock {
  platform?: string;
  region?: Region;
  email?: string;
  password?: string;
  authMethod?: AuthMethod;
  countryCode?: string;
  phoneNumber?: string;
  stripLeadingZero?: boolean;
}

function storagePath(): string {
  const flag = process.argv.indexOf('-U');
  if (flag >= 0 && process.argv[flag + 1]) return process.argv[flag + 1]!;
  return process.env.HOMEBRIDGE_STORAGE_PATH ?? '/var/lib/homebridge';
}

function readPlatformBlock(dir: string): PlatformBlock {
  try {
    const config = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8')) as { platforms?: PlatformBlock[] };
    return (config.platforms ?? []).find((p) => p.platform === PLATFORM_NAME) ?? {};
  } catch {
    return {};
  }
}

/** Credentials never need to live in config.json; a one-time pairing reads them here. */
function readCredentialsFile(): { email?: string; password?: string } {
  try {
    const [email, password] = readFileSync(join(homedir(), '.akuvox', 'credentials'), 'utf8').split('\n');
    return { email: email?.trim() || undefined, password: password || undefined };
  } catch {
    return {};
  }
}

const log = { info: (m: string) => console.log(m), warn: (m: string) => console.warn(m), error: (m: string) => console.error(m) };

const dir = storagePath();
const block = readPlatformBlock(dir);
const file = readCredentialsFile();
const rl = createInterface({ input: process.stdin, output: process.stdout });
const region: Region = block.region ?? 'ecloud';
try {
  if (!REGIONS.includes(region)) throw new Error(`Unknown region "${region}". Expected one of: ${REGIONS.join(', ')}`);
  let method: string | undefined = process.argv.includes('--sms') ? 'sms' : block.authMethod;
  if (!method) {
    if (block.phoneNumber?.trim()) method = 'sms';
    else if (block.email || file.email) method = 'email';
    else method = (await rl.question('Sign-in method (email/sms) [email]: ')).trim().toLowerCase() || 'email';
  }
  if (method !== 'sms' && method !== 'email') throw new Error('Sign-in method must be email or sms');

  let cloud: AkuvoxCloud;
  let result: LoginResult;
  let credentials: { email: string; password: string } | undefined;
  if (method === 'sms') {
    if (process.argv.includes('--strip-leading-zero') && process.argv.includes('--keep-leading-zero')) {
      throw new Error('Choose only one of --strip-leading-zero and --keep-leading-zero');
    }
    const stripLeadingZero = process.argv.includes('--keep-leading-zero') ? false
      : process.argv.includes('--strip-leading-zero') || block.stripLeadingZero === true;
    const phone = normalizePhone(
      block.countryCode?.trim() || await rl.question('Country calling code (e.g. 972): '),
      block.phoneNumber?.trim() || await rl.question('SmartPlus local phone number (without country code): '),
      stripLeadingZero,
    );
    cloud = new AkuvoxCloud(region, '', '');
    console.log(`Requesting an SMS sign-in code from Akuvox (${region}) …`);
    const restServer = await cloud.sendSmsCode(phone.countryCode, phone.phoneNumber);
    const code = (await rl.question('Enter the verification code received by SMS: ')).trim();
    result = await cloud.verifySmsCode(phone.countryCode, phone.phoneNumber, code, restServer);
  } else {
    const email = block.email ?? file.email ?? (await rl.question('SmartPlus account email: ')).trim();
    const password = block.password ?? file.password ?? await rl.question('SmartPlus account password: ');
    credentials = { email, password };
    cloud = new AkuvoxCloud(region, email, password);
    console.log(`Signing in to Akuvox (${region}) as ${email} …`);
    const challenge = await cloud.login();
    if (challenge.result) {
      result = challenge.result;
    } else {
      if (!challenge.needsTwoFactor || !challenge.tempToken) throw new Error('Login returned no token and no two-factor challenge.');
      await cloud.sendTwoFactorCode(challenge.restServer, challenge.tempToken);
      const code = (await rl.question('Enter the verification code emailed to the account: ')).trim();
      result = await cloud.verifyTwoFactorCode(code);
    }
  }

  const sip = await cloud.getSipConfig(result.restServer, result.token);
  const sipServer = sip?.sipServer ?? result.sipServer ?? await cloud.getSipServer(result.token);
  // Pairing replaces any previous account instead of inheriting its session metadata.
  const store = new SessionStore(dir);
  const manager = new SessionManager(cloud, store, log);
  manager.adopt(result, sip, sipServer, true);
  const credentialsStore = new CredentialsStore(dir);
  if (credentials) credentialsStore.write(credentials);
  else credentialsStore.clear();

  const devices = await manager.listDevices();
  console.log('\nPaired. Session saved to the Homebridge storage directory.');
  console.log('Devices visible to this account:');
  for (const d of devices) {
    console.log(`  - ${d.location} (${d.devType === '1' ? 'door station' : 'indoor monitor'}), relays: ${d.relays.map((r) => r.doorName).join(', ') || 'none'}`);
  }
  console.log('\nRestart Homebridge to let the plugin pick up the session.');
} finally {
  rl.close();
}
