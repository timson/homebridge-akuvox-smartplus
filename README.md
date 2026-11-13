# homebridge-akuvox-smartplus-timson

A [Homebridge](https://homebridge.io) plugin that brings an **Akuvox SmartPlus** intercom into
Apple HomeKit through the Akuvox cloud — no extra hub, no Home Assistant.

| HomeKit accessory | Backed by |
|---|---|
| **Video doorbell** (live view + ring) | Cloud RTSP relay (UDP) + a SIP registration that receives the door call |
| **Lock** per door relay | The cloud `opendoor` API |
| **Contact sensor** ("opened") | The member door log |

It signs in with a dedicated **family-member** account and never answers the door call — it only
listens for the ring, so your phones keep ringing as before.

## Requirements

- Homebridge 2, Node 22+
- `ffmpeg` on the host (for camera snapshots and streaming)
- An Akuvox SmartPlus **family-member** account (keep your personal login for your phone)

## Install

```bash
npm install -g homebridge-akuvox-smartplus-timson
```

Or in the Homebridge UI's **Plugins** tab, search for **homebridge-akuvox-smartplus-timson**
and install **Akuvox SmartPlus (timson)**. Requires Homebridge 2 and Node 22 or newer.
When switching from the original package, uninstall `homebridge-akuvox-smartplus` and retain
your existing `AkuvoxSmartPlus` platform configuration and session files.

### Install this GitHub fork

In the Homebridge UI terminal (or a shell on the Homebridge host), clone and build this fork,
then install its packed plugin:

```bash
akuvox_build_dir="$(mktemp -d)"
git clone --depth 1 https://github.com/timson/homebridge-akuvox-smartplus.git "$akuvox_build_dir"
cd "$akuvox_build_dir"
npm ci --global=false --include=dev --ignore-scripts
npm run build
npm pack --ignore-scripts
npm install -g "$akuvox_build_dir/homebridge-akuvox-smartplus-timson-0.5.0.tgz"
```

Use `sudo` for the final install command if your global npm directory requires it. For Docker,
run these commands inside the Homebridge container. Git must be available on the host.
This flow avoids [npm's global Git installation bug](https://github.com/npm/cli/issues/8440),
which can cause `tsc: not found` while preparing a Git dependency. Compilation happens locally;
the global installation consumes a package containing the compiled plugin.

Configure the platform below, run `akuvox-pair --sms` (or `akuvox-pair` for email sign-in), then
restart Homebridge. Repeat these steps to update from this fork's `main` branch.

## Configure

Add the platform (UI or `config.json`). Credentials are **not** required in config — pairing takes
them interactively. Session tokens are stored in owner-only files under the Homebridge storage
directory. Email/password pairing also saves the credentials there for trusted re-login.

```json
{
  "platforms": [
    {
      "platform": "AkuvoxSmartPlus",
      "name": "Akuvox SmartPlus",
      "region": "ecloud",
      "unlockSeconds": 5,
      "doorbell": true
    }
  ]
}
```

| Field | Meaning |
|---|---|
| `region` | Akuvox cloud region: `ecloud` (EU/ME), `ucloud` (Americas), `scloud`, `jcloud`, `ccloud`, `rucloud` |
| `unlockSeconds` | How long the lock shows Unlocked before snapping back (the door is a momentary buzzer) |
| `doorbell` | Register on the intercom PBX for real-time ring notifications |
| `authMethod` | Optional. `email` for email/password or `sms` for phone/SMS pairing; otherwise choose interactively (existing email settings keep email sign-in) |
| `countryCode`, `phoneNumber` | Optional SMS pairing defaults. Country calling code (e.g. `972`) and local phone number without the country code |
| `stripLeadingZero` | Optional, defaults to `false`. Remove one initial zero from the phone number during SMS pairing |
| `email`, `password` | Optional email pairing defaults; credentials entered during pairing are saved separately for trusted re-login |
| `cameras` | Optional. Stream a door station from a local RTSP source (e.g. an NVR channel) instead of the Akuvox cloud, with automatic fallback to the cloud |

### Local camera source (optional)

By default the door camera streams through the Akuvox cloud relay. If the intercom is also
reachable locally — for example as a channel on an NVR — point the plugin at that RTSP URL to
get a faster, cloud-independent stream. It's tried first, and falls back to the cloud if the
local source fails. Match it to the door station by MAC (separators and case are ignored).

```json
{
  "platform": "AkuvoxSmartPlus",
  "region": "ecloud",
  "cameras": [
    {
      "mac": "0C:11:05:2A:60:95",
      "rtspUrl": "rtsp://viewer:password@192.168.1.230:554/cam/realmonitor?channel=1&subtype=1",
      "rtspTransport": "tcp"
    }
  ]
}
```

| Field | Meaning |
|---|---|
| `mac` | The door station's MAC (match is case- and separator-insensitive) |
| `rtspUrl` | Local RTSP URL for that camera. Use a low-privilege viewer account |
| `rtspTransport` | `tcp` (default) or `udp` |

## Pair (one time)

Run the pairing command and choose email/password or phone/SMS sign-in:

```bash
akuvox-pair
```

For email sign-in, enter the email, password and the emailed code if requested.
For passwordless phone sign-in, you can select SMS directly:

```bash
akuvox-pair --sms
```

Enter your country calling code, local phone number and the code received by SMS. For example,
use country code `972` with local number `0501234567`. Leading zeros are preserved by default. The configured
`region` must match your SmartPlus account; it is not inferred from the calling code.
You can also set `"authMethod": "sms"`, `"countryCode": "972"` and `"phoneNumber": "0501234567"`
in the platform configuration. The SMS code is always entered interactively and is never saved.

If your account expects the number without its initial zero, enable `"stripLeadingZero": true`
or run `akuvox-pair --sms --strip-leading-zero`. To preserve the zero even when that setting is
enabled, use `akuvox-pair --sms --keep-leading-zero`. The chosen format is used consistently
for requesting the SMS, verifying its code, and retrieving the account's servers.

Then restart Homebridge. The plugin keeps itself signed in by refreshing its token, including
SMS sessions. SMS pairing saves no password and removes any previously saved email/password.
If SmartPlus invalidates the refresh credential, run `akuvox-pair` again. Use `akuvox-pair -U /path/to/storage`
when your Homebridge storage directory differs from `/var/lib/homebridge` (or set `HOMEBRIDGE_STORAGE_PATH`).

## How it works

```
Apple Home ── Homebridge ── homebridge-akuvox-smartplus ──HTTPS──► Akuvox cloud
                             ├ Lock            → opendoor
                             ├ Video doorbell  → SIP INVITE (ring) + RTSP (UDP) video
                             └ Contact sensor  → member door log (polled)
```

## Credits

Login/unlock/event protocol was observed from the SmartPlus app and informed by the
[nimroddolev/akuvox](https://github.com/nimroddolev/akuvox) Home Assistant integration (MIT).

## License

MIT
