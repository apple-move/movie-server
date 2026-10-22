# 🎬 Movie Server

A self-hosted movie server with **pluggable cloud storage**. Keep your whole
collection in **Cloudflare R2 / Google Drive / MEGA / Telegram** (or local
disk), then **stream online** or **download** straight from the site.

Built with Node.js + Express + a vanilla-JS SPA. No build step, no framework
churn, no native compilation — it just runs.

---

## ✨ Features

### Storage
| | |
|---|---|
| ☁️ **5 storage backends** | Local disk, Cloudflare R2, Google Drive, MEGA, Telegram |
| 🔢 **Unlimited instances** | Run **several R2 buckets** and **several MEGA accounts** side by side — add them from the Admin panel, no `.env` editing |
| 🗂️ **ZIP playback** | Upload a `.zip` and the player lists the files inside and streams the one you pick — without downloading the archive |
| 📺 **HLS playback** | `.m3u8` playlists are proxied through the server, segments included, with AES keys handled |
| 🔄 **Remux jobs** | Built-in ffmpeg worker turns `.mkv` into browser-playable `.mp4` (fast, no quality loss) |

### Playback
| | |
|---|---|
| ⚡ **True streaming** | Real HTTP Range requests — a 4K file starts playing instantly and seeking is instant |
| 🎚️ **Quality control** | Pick the resolution (Original / 1080p / 720p / 480p / 360p / 240p) and the audio bitrate — the file is converted on the fly by ffmpeg while you watch, and the current quality is shown in the top bar |
| 🎛️ **Master player** | Speed, frame stepping, A–B loop, PiP, aspect ratio, picture filters, volume boost to 200 %, snapshots, live stats |
| 💬 **Subtitles** | Auto-detected, styled, with a sync offset, converted from SRT to WebVTT on the fly |
| 🔖 **Bookmarks & chapters** | Save positions, jump between chapters, resume exactly where you stopped |
| ⏭️ **Next / previous episode** | A movie holding several episodes moves between them; otherwise between movies |
| ⏱️ **Sleep timer** | Pause automatically after 5–60 minutes |
| ⬇️ **Downloads** | One click, original filename preserved |

### Management
| | |
|---|---|
| 👥 **Admin + members** | JWT + bcrypt, server-side sessions you can revoke remotely |
| 🔐 **Two-factor auth** | TOTP (Google Authenticator, Aegis, Authy…) built in, no dependency |
| 📋 **Audit trail** | Every meaningful action is recorded and searchable |
| 🚫 **IP bans** | Block abusive addresses from the Admin panel |
| 🎬 **One-click TMDB import** | Paste the API key in the Admin panel — every movie you add then gets its **full details** automatically: synopsis, tagline, runtime, rating, genres, keywords, poster, backdrop, **cast, crew and trailer** |
| 📤 **Browser uploads** | Drag & drop a file straight into any provider |
| 🔁 **Auto-scanner** | Walks a provider and imports files, guessing titles, years, and quality |

---

## 🎬 Adding a movie with full TMDB details

The fastest way to fill the library:

1. Open **Admin → Movies**.
2. Paste your free TMDB API key (get one at
   [themoviedb.org/settings/api](https://www.themoviedb.org/settings/api)) —
   it is stored in the database, not in `.env`, so you can change it any time.
3. Search for the title and press **Import with details**.

The entry is created complete in one call:

| Field | Field |
|---|---|
| Title & original title | Release date |
| Year | Runtime |
| Tagline | Rating + vote count |
| Synopsis | Genres & keywords |
| Poster & backdrop | **Cast** (with photos) |
| Status | **Crew** (director, writer, producer) |
| | **Trailer** link |

The cast and trailer are shown in the movie's detail sheet and in the
player's info panel.

> The key can also be set with `TMDB_API_KEY` in `.env`. A key saved in the
> Admin panel takes priority, so you can rotate it without a restart.

---

## 🚀 Quick start

```bash
git clone <your-repo> movie-server && cd movie-server
npm install
cp .env.example .env      # then edit .env
npm start
```

Open <http://localhost:3000>. The **first account you create becomes the
admin**.

> **Node.js 22.5+ is required** (it uses the built-in `node:sqlite`, so there
> is no native compilation step). On Node 22.x the SQLite module still needs a
> flag — start the server with `node --experimental-sqlite server/index.js`.
> Node 23.4 and newer need no flag.

Create the admin account from the terminal instead:

```bash
npm run admin:create
```

---

## ⚙️ Configuration

Everything lives in `.env` (see `.env.example`). **Every storage provider is
optional** — enable only what you use, and add more instances later from the
Admin panel.

### Core

```ini
PORT=3000
HOST=0.0.0.0
JWT_SECRET=change-me-to-a-long-random-string   # REQUIRED in production
PUBLIC_URL=https://movies.example.com
TRUST_PROXY=1                                    # behind Nginx/Cloudflare
DB_PATH=./data/movie-server.db
LIBRARY_ROOT=./data/library
DEBUG=false                                      # never on a public server
JOB_TOKEN=some-long-random-string                # lets the ffmpeg worker read sources
```

### ☁️ Cloudflare R2 — *recommended*

R2 is the best option for a real library: **no egress fees**, native range
requests, and unlimited-ish storage (billed per GB).

1. Create a bucket in the Cloudflare dashboard.
2. **R2 → Manage API Tokens → Create Account API Token** → Object Read & Write.
3. Fill in:

```ini
R2_ACCOUNT_ID=your_account_id
R2_ACCESS_KEY_ID=xxx
R2_SECRET_ACCESS_KEY=xxx
R2_BUCKET=movies
```

### 📁 Google Drive — *15 TB free*

Works with a **service account** (recommended — share one folder with it) or
your own OAuth refresh token.

```ini
GOOGLE_SERVICE_ACCOUNT_EMAIL=xxx@xxx.iam.gserviceaccount.com
GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\nMIIE...\n-----END PRIVATE KEY-----\n"
GOOGLE_DRIVE_FOLDER_ID=1AbCdEf...        # the folder the service account can see
```

Create a service account at [console.cloud.google.com/iam-admin/serviceaccounts](https://console.cloud.google.com/iam-admin/serviceaccounts),
enable the **Google Drive API**, then **share your movies folder with the
service account's email address**.

### 🗄️ MEGA — *20 GB free per account*

```ini
MEGA_EMAIL=you@example.com
MEGA_PASSWORD=your-password
MEGA_ROOT_FOLDER=Movies              # optional: only expose this folder
```

### ✈️ Telegram — *small files only*

```ini
TELEGRAM_BOT_TOKEN=123456:ABC-DEF...
TELEGRAM_CHAT_ID=your-chat-id
```

> ⚠️ **Telegram has hard limits:** the Bot API caps uploads at **50 MB** and
> downloads at **20 MB**. Use it for trailers, clips and subtitles — not for
> full-length features. Use R2 or Drive for those.

### 🎨 TMDB (optional, for posters)

```ini
TMDB_API_KEY=your_key
```

Get a free key at [themoviedb.org/settings/api](https://www.themoviedb.org/settings/api).

---

## 🔢 Using several providers at once

You are **not** limited to one account per provider type. Add as many
instances as you like from **Admin → Storage → + Add provider**:

| Type | You can run |
|---|---|
| `r2` | One instance per bucket — a personal one, a 4K archive, a shared one… |
| `mega` | One instance per MEGA account — 20 GB each, all usable together |
| `gdrive` | One instance per service account / folder |
| `local` | One instance per folder (mount a second disk this way) |
| `telegram` | One instance per bot |

Each instance gets its own id (`r2_backup`, `mega_2`, …). The scanner, the
uploader and the file browser all let you pick which instance to use, and the
Admin panel shows the disk usage of each one separately.

---

## 🔗 Adding a movie by URL

Any HTTP(S) URL works — you do not have to upload the file first.

**Admin → Movies → URL**, then paste the link:

| The URL points to | What happens |
|---|---|
| A video file (`.mp4`, `.mkv`, …) | It is streamed straight through the server, with full seeking support |
| A `.zip` archive | The contents are listed and you pick the file inside the player |

Only admins can add a URL, and the URL is checked before it is fetched:

- `http` and `https` only
- no credentials in the URL
- **private and reserved addresses are refused** — loopback, `10.x`, `172.16.x`,
  `192.168.x`, `169.254.x` (cloud metadata), `100.64.x`, IPv6 loopback and
  unique-local, `0.0.0.0`
- every redirect hop is re-checked
- a URL that resolves to a private address can only be used when
  `ALLOW_PRIVATE_URLS=true` is set (useful for a NAS on your own LAN)

---

## 📂 Adding your movies

There are three ways — use whichever fits.

### 1. Scan a provider (recommended)

Put your files in a predictable layout, then hit **Scan** in the Admin panel:

```
Movies/
  Inception (2010)/
    Inception.2010.1080p.BluRay.mkv
    Inception.2010.en.srt          ← subtitle auto-detected
    poster.jpg                     ← poster auto-detected
  The Matrix (1999).zip            ← archive: browsable inside the player
  Documentary/
    master.m3u8                    ← HLS playlist
    seg001.ts
    seg002.ts
```

The scanner reads the folder name and file name to guess the title, year, and
quality (`1080p`, `4K`, `BluRay`, `WEB-DL`…).

Scan from the CLI too:

```bash
npm run scan -- r2            # scan Cloudflare R2
npm run scan -- gdrive        # scan Google Drive
npm run scan -- local         # scan the local library folder
npm run scan -- mega Movies   # scan a MEGA sub-folder
```

### 2. Upload from the browser

**Admin → Upload** — drag & drop a file, pick the provider instance and
folder, and optionally attach it to an existing movie. Large files stream to
storage without buffering in memory.

### 3. Import from TMDB

**Admin → Movies** — search TMDB and one click imports the title, poster,
backdrop, synopsis, genres, runtime, and rating. Then attach your file.

---

## 🗂️ ZIP archives

Upload or scan a `.zip` and it becomes a browsable source. The player shows
every file inside the archive and streams the one you pick:

- The archive's central directory is read with **range requests**, so the
  server never downloads the whole `.zip`.
- **Stored** entries (uncompressed) stream with perfect seeking.
- **Deflated** entries are inflated on the fly.
- The archive stays in storage — only the bytes of the file you play are
  transferred.

> `.rar` and `.7z` are detected too, but need an external tool to extract;
> `.zip` is supported natively.

---

## 📺 HLS streaming

Upload or scan an `.m3u8` and it is played as an HLS stream:

- Master playlists expose their **variant qualities** in the source menu.
- Media playlists, segments and **AES-128 encryption keys** are all proxied
  through the server, so nothing is exposed and every request stays
  authenticated.
- Segments support range requests.
- `hls.js` is bundled and loaded on demand, so HLS plays in **Chrome and
  Firefox** as well as Safari.

> The ffmpeg worker needs to reach your own `PUBLIC_URL` to read an HLS
> stream. If the server is behind a split-horizon DNS or a hairpin NAT,
> point `PUBLIC_URL` at an address it can actually reach.

---

## 🎛️ The player

A VLC-style player, built for the browser:

- **Playback speed** 0.25× → 4×
- **Frame stepping** (`,` / `.`)
- **A–B loop** with a visual region on the scrub bar
- **Picture-in-picture**
- **Aspect ratio** (auto / 16:9 / 4:3 / 21:9 / 1:1) and **picture filters**
  (brighter, dimmer, high contrast, warm)
- **Volume boost** up to 200 %
- **Subtitles**: multiple tracks, six styles, and a **sync offset** slider
- **Sleep timer** — pause automatically after 5–60 minutes
- **Bookmarks** (saved server-side) and **chapter markers**
- **Snapshots** saved straight to your downloads folder
- **Audio track** selection when the file has more than one
- **Share link** — copy a direct link to the movie
- **Next / previous movie** without leaving the player
- **Live statistics**: resolution, buffer, dropped frames, speed, volume
- **Source switching** between multiple qualities/versions of a film
- **Buffering spinner** and a **hover time preview** on the scrub bar

**Keyboard shortcuts**

| Key | Action | Key | Action |
|---|---|---|---|
| `Space` / `K` | Play / pause | `L` | A–B loop |
| `←` / `→` | Seek ∓10s | `B` | Bookmark |
| `↑` / `↓` | Volume | `P` | Picture-in-picture |
| `M` | Mute | `I` | Statistics |
| `F` | Fullscreen | `S` | Snapshot |
| `T` | Theatre mode | `C` | Movie info |
| `,` / `.` | Frame step | `+` / `-` | Speed |
| `?` | All shortcuts | `Esc` | Close |

---

## 🚀 Deployment (VPS, no Docker)

### 1. Install

```bash
# Node 22.5+
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs nginx

sudo mkdir -p /var/www/movie-server
sudo chown -R $USER:$USER /var/www/movie-server
cd /var/www/movie-server
# copy your project here, then:
npm ci --omit=dev
```

### 2. Configure

```bash
cp .env.example .env
nano .env      # set JWT_SECRET, JOB_TOKEN, PUBLIC_URL, storage credentials
```

Generate strong secrets:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

> The server **refuses to start in production** with a placeholder
> `JWT_SECRET` — it will not silently run with a publicly known key.

### 3. Run with PM2

```bash
sudo npm install -g pm2
pm2 start server/index.js --name movie-server
pm2 save
pm2 startup     # follow the printed command to enable boot persistence
```

### 4. Nginx + HTTPS

```nginx
server {
    listen 80;
    server_name movies.example.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    server_name movies.example.com;

    ssl_certificate     /etc/letsencrypt/live/movies.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/movies.example.com/privkey.pem;

    # Streaming: don't buffer, allow large uploads.
    client_max_body_size 20G;
    proxy_buffering off;
    proxy_request_buffering off;
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;

    location / {
        proxy_pass         http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header   Host              $host;
        proxy_set_header   X-Real-IP         $remote_addr;
        proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;

        # Pass the Range header through so seeking works.
        proxy_set_header   Range             $http_range;
        proxy_set_header   If-Range          $http_if_range;
    }
}
```

```bash
sudo certbot --nginx -d movies.example.com
sudo nginx -t && sudo systemctl reload nginx
```

Then set `TRUST_PROXY=1` and `PUBLIC_URL=https://movies.example.com` in `.env`
and restart: `pm2 restart movie-server`.

> ⚠️ **If you use Cloudflare's proxy, set the DNS record to "DNS only"**
> (grey cloud) for large files — proxying breaks range requests.

### 5. Optional: ffmpeg

```bash
sudo apt install -y ffmpeg
```

Enables the remux/transcode job queue.

---

## 📸 Screenshots

| | | |
|---|---|---|
| ![Home](screenshots/02-home.png) | ![Player](screenshots/05-player.png) | ![Admin](screenshots/06-admin-storage.png) |

More in the [`screenshots/`](screenshots/) folder — they are regenerated by
`npm run test:ui`.

---

## 🔌 API

All endpoints live under `/api`. Authenticate with `Authorization: Bearer <token>`
(the login response) or the `ms_token` cookie.

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/api/auth/register` | Register (first account becomes admin) |
| `POST` | `/api/auth/login` | Log in → token + cookie (supports `totp`) |
| `GET` | `/api/auth/me` | Current user |
| `POST` | `/api/auth/2fa/setup` · `/enable` · `/disable` | Two-factor auth |
| `GET` | `/api/auth/sessions` · `DELETE /:id` | Manage sessions |
| `GET/POST/PATCH/DELETE` | `/api/auth/users[/:id]` | Manage users *(admin)* — a user may also PATCH their own profile |
| `GET/POST/DELETE` | `/api/auth/2fa/{setup,enable,disable}` | Two-factor auth |
| `GET/DELETE` | `/api/auth/sessions[/:id]` | Manage sessions |
| `GET` | `/api/movies` | Browse — `?q=`, `?genre=`, `?year=`, `?sort=`, `?featured=`, `?limit=`, `?offset=` |
| `POST` | `/api/movies` | Create a movie *(admin)* |
| `PATCH/DELETE` | `/api/movies/:id` | Update / delete *(admin)* |
| `GET` | `/api/movies/:id/related` | Similar titles |
| `GET/POST` | `/api/movies/:id/progress` | Watch position (resume) |
| `GET/POST/DELETE` | `/api/movies/:id/bookmarks[/:id]` | Bookmarks |
| `GET` | `/api/movies/progress/bulk` | All watch positions in one call |
| `POST` | `/api/movies/:id/sources` | Attach a storage file, archive or playlist *(admin)* |
| `GET` | `/api/movies/:id/archive` | List the contents of a `.zip` *(admin)* |
| `GET` | `/api/movies/meta/genres` | Genre list |
| `GET` | `/api/movies/meta/providers` | Storage provider status |
| `GET` | `/api/stream/:sourceId` | **Stream** with Range support |
| `GET` | `/api/stream/:sourceId?entry=…` | **Stream a file inside a `.zip`** |
| `GET` | `/api/stream/:sourceId/hls?path=…` | **HLS playlist / segment** |
| `GET` | `/api/stream/:sourceId/download` | **Download** as attachment |
| `GET` | `/api/stream/:sourceId/subtitle/:id` | Subtitle track (auto SRT→VTT) |
| `GET` | `/api/stream/:sourceId/info` | Source metadata, archive entries, HLS variants |
| `POST` | `/api/upload` | Multipart upload to a provider *(admin)* |
| `GET` | `/api/upload/existing` | List files already in a provider *(admin)* |
| `GET` | `/api/upload/subtitles` | Find subtitles next to a movie *(admin)* |
| `GET` | `/api/browse/remote` | Browse a provider's files *(admin)* |
| `GET/POST/PATCH/DELETE` | `/api/admin/providers[/:id]` | Manage provider instances *(admin)* |
| `GET` | `/api/admin/providers/:id/usage` | Storage usage per instance *(admin)* |
| `GET/POST/DELETE` | `/api/admin/jobs[/:id]` | ffmpeg job queue *(admin)* |
| `GET/DELETE` | `/api/admin/audit` | Audit trail *(admin)* |
| `GET/DELETE` | `/api/admin/sessions[/:id]` | Active sessions *(admin)* |
| `GET/POST/DELETE` | `/api/admin/bans[/:ip]` | IP bans *(admin)* |
| `GET/PUT` | `/api/admin/settings` | Server settings *(admin)* |
| `POST` | `/api/admin/scan` | Import a provider into the library *(admin)* |
| `POST` | `/api/admin/enrich/:movieId` | Pull TMDB metadata *(admin)* |
| `GET` | `/api/admin/tmdb/search?q=` | Search TMDB *(admin)* |
| `GET` | `/api/admin/tmdb/:tmdbId` | Full TMDB details *(admin)* |
| `POST` | `/api/admin/tmdb/import` | **Add a movie with every TMDB detail** *(admin)* |
| `GET/PUT` | `/api/admin/tmdb/key` | Manage the TMDB API key *(admin)* |
| `POST` | `/api/admin/bulk` | Bulk feature / unfeature / delete *(admin)* |
| `GET` | `/api/images?provider=&path=` | Posters and backdrops |
| `GET` | `/api/health` | Health check |

---

## 🧪 Tests

```bash
npm test              # import check + API suite
npm run test:api      # API suite (98 assertions)
npm run test:archive  # ZIP + HLS + multi-provider + malformed archives (81)
npm run test:security # security regressions + SSRF (35)
npm run test:tmdb     # TMDB key + full-import fields (15)
npm run test:url      # add-by-URL: video, ZIP, SSRF (22)
npm run test:quality  # on-the-fly quality control (32)
npm run test:ui       # browser UI suite (80, real Chrome)
npm run test:player   # every player option, in a real browser
```

`test:ui` drives a real browser through login → browse → detail → player →
admin → account, and writes screenshots to `screenshots/`.

```bash
npm run test:playback -- test.mp4   # real video playback + seeking
npm run test:remux                 # MKV → MP4 conversion job (needs ffmpeg)
```

To generate a test clip:

```bash
ffmpeg -f lavfi -i "testsrc=size=640x360:rate=25:duration=10" \
       -f lavfi -i "sine=frequency=440:duration=10" \
       -c:v libx264 -pix_fmt yuv420p -c:a aac -shortest test.mp4
```

---

## 📁 Project structure

```
server/
  index.js              Express app + startup
  config.js             .env parsing and config
  db.js                 SQLite schema + migrations (node:sqlite)
  lib/
    auth.js             bcrypt + JWT + route guards
    rate-limit.js       failure tracking for the login endpoint
    sessions.js         server-side session tracking
    audit.js            audit trail
    totp.js             two-factor authentication
    ip-ban.js           blocked addresses
    range.js            HTTP Range parsing / byte limiting
    zip.js              ZIP central-directory reader + entry streaming
    hls.js              playlist rewriting
    subtitle.js         subtitle language detection
    mime.js             Content-type detection
  providers/            One factory per storage backend
    local.js  r2.js  gdrive.js  mega.js  telegram.js
    index.js            instance registry (many instances per type)
  routes/
    auth.js  movies.js  stream.js  upload.js  admin.js  bookmarks.js
  services/
    scanner.js          Auto-import + title guessing
    tmdb.js             TMDB metadata client
    jobs.js             ffmpeg remux / transcode worker
  cli/
    create-admin.js     npm run admin:create
    scan.js             npm run scan
public/                 Vanilla-JS SPA (no build step)
  index.html  css/  js/views/
scripts/                Test suites
data/                   SQLite DB, local library, temp uploads (gitignored)
```

### Adding a new storage provider

1. Create `server/providers/yourprovider.js` exporting a **factory**:
   `createYourProvider(instance)` returning an object with
   `id`, `type`, `name`, `icon`, `isConfigured()`, `init()`,
   `list(prefix)`, `stat(path)`, `createReadStream(path, {start, end})`,
   `upload(path, source, opts)`, `delete(path)`, `exists(path)`, `usage()`.
2. Register it in `server/providers/index.js` (`FACTORIES`, `PROVIDER_TYPES`,
   `PROVIDER_FIELDS`).
3. Add a seed entry so it gets a default slot.

The streaming, download, upload, scan, ZIP and HLS layers pick it up
automatically.

---

## 🔒 Security

- Passwords are hashed with **bcrypt** (12 rounds).
- Sessions use a signed **JWT** *plus* a **server-side session row**, so a
  device can be signed out remotely — revoking a session takes effect
  immediately, even though the JWT itself is still valid.
- **Two-factor authentication** (TOTP) is built in — no extra dependency.
- The library is **not** publicly enumerable — every read route requires a
  session.
- Login is rate limited on **two independent counters**: 10 failures per
  account and 50 failures per IP per 15 minutes. Only *failed* attempts
  count, and a success clears the account counter. A spoofed
  `X-Forwarded-For` therefore cannot reset the limit.
- The **HLS playlist route** is scoped twice: a requested file must live
  inside the playlist's own directory *and* be a file the playlist actually
  references. A crafted playlist cannot be turned into a pointer at other
  objects in the bucket.
- **ZIP parsing** is hardened: the central directory is bounds-checked, a
  lying extra-field length cannot read past the buffer, ZIP64 archives
  without a locator are rejected, and the directory size is capped.
- Every meaningful action is written to an **audit log**.
- **IP bans** are enforced before any route runs. An admin who bans their
  own address is not locked out.
- Provider credentials are **never returned by the API** — the admin
  endpoints return a redacted row, and editing a provider *merges* the
  config so a blank field can never wipe a stored secret.
- Path traversal is blocked in the local provider.
- A **Content-Security-Policy** and other security headers are set on every
  response.
- The server **refuses to start in production** with a placeholder
  `JWT_SECRET`.
- `DEBUG` is off by default, so internal errors are never echoed to clients.
- The ffmpeg job token is sent as an `X-Job-Token` **header**, never in the
  query string, and is compared in constant time.
- Put it behind **HTTPS** (Nginx + Let's Encrypt) before exposing it.
- If you use Google Drive with a service account, only share the one folder.

> **Deployment caveat:** `TRUST_PROXY` decides whether `X-Forwarded-For` is
> believed. The default (`loopback`) only trusts a proxy on the same machine.
> Set it to `1` behind Nginx — but only if the app port is *not* directly
> reachable, otherwise clients can spoof their IP and weaken the rate
> limiter.

---

## ❓ Troubleshooting

**"Playback error" in the browser**
The codec isn't supported. Browsers handle MP4/H.264 and WebM. Remux an MKV
from **Admin → Jobs**, or use the download button.

**Seeking doesn't work**
Something is stripping the `Range` header. If you're behind Nginx, make sure
`proxy_set_header Range $http_range;` and `proxy_buffering off;` are set. If
you're behind Cloudflare, set the DNS record to **DNS only** (grey cloud).

**Upload fails immediately**
Check `MAX_UPLOAD_SIZE` and Nginx's `client_max_body_size`. For Telegram,
remember the 50 MB cap.

**Provider shows "Not configured"**
Fill in its details in **Admin → Storage**. The status column updates right
away.

**The ZIP entry won't play**
The archive must be a real `.zip` (PK format). `.rar` and `.7z` need an
external tool. Check the archive listing in **Admin → Movies → Attach**.

**Everything is slow**
You're probably streaming through the Node process. R2 can hand out
presigned URLs so the browser pulls directly from Cloudflare instead.

**The server exited on start**
Production mode with a placeholder `JWT_SECRET` is refused on purpose. Set a
real one.

---

## 📄 License

MIT — do whatever you want with it.
