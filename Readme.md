moviesapi-proxy
A lightweight Express proxy that sits in front of moviesapi.to and forwards your requests in the background with the full set of browser headers (cookie, x-player-key, referer, origin, sec-*, user-agent), so the upstream treats every call as a genuine same-origin request.

Routes
Method	Local endpoint	Proxied to (moviesapi.to)
GET	/api/movie/:id	https://moviesapi.to/api/vidora/v1/movie/:id
GET	/api/tv/:id/:seasonno/:episodeno	https://moviesapi.to/api/vidora/v1/tv/:id/:seasonno/:episodeno
GET	/api/cache/stats	Cache statistics (entries, TTL, enabled)
DELETE	/api/cache	Clear the entire cache
POST	/api/cache/invalidate/:key	Invalidate a single cache key (e.g. movie:533535)
GET	/	Health check / route list
Examples
# Movie (I, Robot — tmdb 533535)curl http://localhost:3000/api/movie/533535# TV (Stranger Things — tmdb 66732, S1 E3)curl http://localhost:3000/api/tv/66732/1/3# Same TV episode, but route playback through a Cloudflare Workercurl http://localhost:3000/api/tv/66732/1/3?worker=1
?worker=1 — Cloudflare Worker passthrough
Append ?worker=1 (or ?worker=true) to any movie/TV request to rewrite every stream URL in the response so playback is routed through a Cloudflare Worker:

Before:  https://bx.netrocdn.site/hls2/05/00003/j0jewvucfl2f_,h,x,.urlset/master.m3u8?t=...After:   https://fragrant-hall-7347.ntb7nmytsd.workers.dev/https://bx.netrocdn.site/hls2/05/00003/j0jewvucfl2f_,h,x,.urlset/master.m3u8?t=...
The rewriter walks the entire JSON response and prefixes every http(s):// URL it finds (so sources[].url, tracks[].file, etc. are all covered).
It is idempotent — already-rewritten URLs are never double-wrapped.
The original (non-worker) cached entry is not mutated — a deep clone is rewritten on read, so a single cache entry serves both modes.
Each response carries an X-Worker: ON|OFF header so clients can tell at a glance.
Override the worker URL via env var:

export WORKER_URL="https://your-worker.your-subdomain.workers.dev"
Sample response (TV):

{  "result": true,  "type": "tv",  "title": "Stranger Things",  "tmdb_id": "66732",  "imdb_id": "tt4574334",  "season": 1,  "episode": 3,  "view_type": "episode",  "view_id": 50521,  "sources": [    {      "file_code": "j0jewvucfl2f",      "url": "https://bx.netrocdn.site/hls2/05/00003/j0jewvucfl2f_,h,x,.urlset/master.m3u8?t=...&e=43200&...",      "source": "vidora",      "tracks": []    }  ]}
How it works
Your client calls the local Express endpoint (e.g. /api/movie/533535).
The server builds a request to moviesapi.to with the exact same headers a browser would send:
cookie (XSRF-TOKEN, vidspark-session)
x-player-key
referer + origin pointing at https://moviesapi.to
user-agent (Chrome 155)
sec-ch-ua, sec-fetch-* headers
axios performs the call in the background, decompresses the response, and Express returns the JSON straight back to your client.
If the upstream returned a 2xx success, the response is stored in an in-memory cache. The next identical request is served directly from memory (no upstream round-trip) until it expires.
Caching
Only successful (HTTP 2xx) upstream responses are cached. This keeps your proxy fast for popular movie/episode lookups while ensuring transient errors (4xx/5xx, network failures, expired cookies returning HTML) are never poisoned into the cache.

Property	Default	Env var	Description
Cache enabled	true	CACHE_ENABLED	Set to false to disable caching entirely
TTL	3600000 ms (1 hour)	CACHE_TTL_MS	How long each entry stays fresh
Every proxied response carries an X-Cache response header:

X-Cache: HIT — served from cache
X-Cache: MISS — fetched from upstream (and stored if 2xx)
Cache management endpoints
# view cache statscurl http://localhost:3000/api/cache/stats# {"enabled":true,"entries":2,"expired_pending_eviction":0,"ttl_ms":3600000}# clear the entire cachecurl -X DELETE http://localhost:3000/api/cache# {"result":true,"cleared":2}# invalidate a single keycurl -X POST http://localhost:3000/api/cache/invalidate/movie:533535# {"result":true,"existed":true,"key":"movie:533535"}
Cache keys follow the pattern movie:<id> and tv:<id>:<seasonno>:<episodeno>. Expired entries are evicted lazily on read.

Setup
1. Install dependencies
cd moviesapi-proxynpm install
2. (Optional) Configure credentials
The x-player-key is baked in as a default. The XSRF-TOKEN and vidspark-session cookies expire, so if the upstream starts returning 419 / 401 / HTML instead of JSON, grab fresh ones from your browser:

Open https://moviesapi.to/movie/533535 in Chrome.
DevTools → Application → Cookies → copy the decoded values of:
XSRF-TOKEN (URL-decoded)
vidspark-session (URL-decoded)
Pass them in via env vars (a .env file works with dotenv, or just export them):
export XSRF_TOKEN="your_decoded_xsrf_token_here"export VIDSPARK_SESSION="your_decoded_session_here"export X_PLAYER_KEY="3a67e8866ae1d2bb9e81fe7f73315a56eb3bdf5e3e755c7554c8be6910aa6b13"export PORT=3000export THEME=8b5cf6export CACHE_ENABLED=trueexport CACHE_TTL_MS=3600000  # 1 hourexport WORKER_URL="https://fragrant-hall-7347.ntb7nmytsd.workers.dev"
Tip: the easiest way is to copy the decoded token values. In DevTools, the cookie value column shows URL-encoded text — decode it (e.g. at https://www.urldecoder.org/) before exporting.

3. Run
# productionnpm start# development (auto-reload on file change)npm run dev
Server logs:

─────────────────────────────────────────────  moviesapi-proxy running on port 3000  Movie : http://localhost:3000/api/movie/:id  TV    : http://localhost:3000/api/tv/:id/:seasonno/:episodeno  Cache : ON (TTL 3600000ms)  Worker: https://fragrant-hall-7347.ntb7nmytsd.workers.dev  (pass ?worker=1 to enable)─────────────────────────────────────────────
Running in the background
# using nohupnohup node server.js > proxy.log 2>&1 &# or using PM2npm install -g pm2pm2 start server.js --name moviesapi-proxypm2 logs moviesapi-proxy
Environment variables
Variable	Default	Purpose
PORT	3000	Port the Express server listens on
THEME	8b5cf6	Theme query param appended to the referer URL
XSRF_TOKEN	(empty)	Decoded XSRF-TOKEN cookie value
VIDSPARK_SESSION	(empty)	Decoded vidspark-session cookie value
X_PLAYER_KEY	baked-in default	The x-player-key header value
CACHE_ENABLED	true	Enable / disable in-memory caching
CACHE_TTL_MS	3600000 (1h)	TTL for cached successful responses
WORKER_URL	https://fragrant-hall-7347.ntb7nmytsd.workers.dev	Cloudflare Worker URL prepended to stream URLs when ?worker=1 is passed
Project structure
moviesapi-proxy/├── package.json├── server.js└── README.md
Notes & caveats
The zstd encoding is intentionally not requested (axios has no native zstd decoder). gzip, deflate, and br are requested and auto-decompressed.
This proxy passes through whatever status code moviesapi.to returns (200, 404, 419, etc.). On a network failure (no response), it returns 502 with a JSON error body.
Cookies on moviesapi.to rotate periodically — re-grab them from the browser when the proxy stops returning JSON.
Use responsibly and in accordance with moviesapi.to's terms of service.
