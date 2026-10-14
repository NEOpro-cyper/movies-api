/**
 * moviesapi-proxy — Express server
 * ------------------------------------------------------------------
 * Acts as a background proxy in front of https://moviesapi.to
 *
 * Routes:
 *   GET /api/movie/:id
 *       -> https://moviesapi.to/api/vidora/v1/movie/:id
 *
 *   GET /api/tv/:id/:seasonno/:episodeno
 *       -> https://moviesapi.to/api/vidora/v1/tv/:id/:seasonno/:episodeno
 *
 * Every upstream request carries the full set of browser headers
 * (cookie, x-player-key, referer, origin, sec-* headers, user-agent)
 * so moviesapi.to accepts it as a genuine same-origin call.
 * ------------------------------------------------------------------
 */

const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;
const THEME = process.env.THEME || '8b5cf6';

/* ---------- Worker proxy config ----------
 * When a request includes ?worker=1, every stream URL in the response is
 * rewritten as `${WORKER_URL}/${originalUrl}` so playback is routed through
 * the Cloudflare Worker (e.g. to bypass CORS / regional blocks).
 */
const WORKER_URL = (
    process.env.WORKER_URL || 'https://fragrant-hall-7347.ntb7nmytsd.workers.dev'
).replace(/\/+$/, ''); // strip trailing slash

/* ---------- Cache config (successful responses only) ---------- */
const CACHE_TTL_MS = parseInt(process.env.CACHE_TTL_MS || '3600000', 10); // default 1 hour
const CACHE_ENABLED = (process.env.CACHE_ENABLED || 'true').toLowerCase() !== 'false';

/** @type {Map<string, {status:number, data:any, expiresAt:number, cachedAt:number}>} */
const cache = new Map();

/* ---------- Cache helpers ---------- */
function isCacheable(status) {
    return CACHE_ENABLED && status >= 200 && status < 300;
}

function getCache(key) {
    if (!CACHE_ENABLED) return null;
    const entry = cache.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
        cache.delete(key); // expired — evict
        return null;
    }
    return entry;
}

function setCache(key, status, data) {
    if (!isCacheable(status)) return; // store successful responses only
    cache.set(key, {
        status,
        data,
        cachedAt: Date.now(),
        expiresAt: Date.now() + CACHE_TTL_MS
    });
}

function cacheStats() {
    let expired = 0;
    const now = Date.now();
    for (const [, v] of cache) if (now > v.expiresAt) expired++;
    return {
        enabled: CACHE_ENABLED,
        entries: cache.size,
        expired_pending_eviction: expired,
        ttl_ms: CACHE_TTL_MS
    };
}

/* ---------- Configurable credentials (override via .env / env vars) ---------- */
const XSRF_TOKEN = process.env.XSRF_TOKEN || '';
const VIDSPARK_SESSION = process.env.VIDSPARK_SESSION || '';
const X_PLAYER_KEY =
    process.env.X_PLAYER_KEY ||
    '3a67e8866ae1d2bb9e81fe7f73315a56eb3bdf5e3e755c7554c8be6910aa6b13';

/* ---------- Middleware ---------- */
app.use(cors());
app.use(express.json());

/* ---------- Build the cookie header ---------- */
function buildCookieHeader() {
    const parts = [];
    if (XSRF_TOKEN) parts.push(`XSRF-TOKEN=${XSRF_TOKEN}`);
    if (VIDSPARK_SESSION) parts.push(`vidspark-session=${VIDSPARK_SESSION}`);
    return parts.join('; ');
}

/* ---------- Build the full header set moviesapi.to expects ---------- */
function buildUpstreamHeaders(referer) {
    const cookie = buildCookieHeader();
    const headers = {
        accept: '*/*',
        // keep gzip/deflate/br — axios decompresses these automatically.
        // (omitting zstd since axios has no native zstd decoder)
        'accept-encoding': 'gzip, deflate, br',
        'accept-language': 'en-US,en;q=0.9',
        origin: 'https://moviesapi.to',
        priority: 'u=1, i',
        referer,
        'sec-ch-ua':
            '"Google Chrome";v="155", "Chromium";v="155", "Not(A:Brand";v="24"',
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"Windows"',
        'sec-fetch-dest': 'empty',
        'sec-fetch-mode': 'cors',
        'sec-fetch-site': 'same-origin',
        'user-agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36',
        'x-player-key': X_PLAYER_KEY
    };
    if (cookie) headers.cookie = cookie;
    return headers;
}

/* ---------- Worker URL rewriter ----------
 * Deep-walks the response object and prefixes any string that looks like an
 * http(s) URL with `${WORKER_URL}/`. Already-rewritten URLs are skipped so
 * the function is idempotent.
 *
 * Operates on a deep clone so the cached pristine copy is never mutated.
 */
function applyWorker(data) {
    const clone = JSON.parse(JSON.stringify(data));
    rewriteUrlsInPlace(clone);
    return clone;
}

function rewriteUrlsInPlace(node) {
    if (Array.isArray(node)) {
        for (let i = 0; i < node.length; i++) node[i] = rewriteValue(node[i]);
    } else if (node && typeof node === 'object') {
        for (const k of Object.keys(node)) node[k] = rewriteValue(node[k]);
    }
    return node;
}

function rewriteValue(v) {
    if (typeof v === 'string' && /^https?:\/\//i.test(v) && !v.startsWith(WORKER_URL + '/')) {
        return `${WORKER_URL}/${v}`;
    }
    if (v && typeof v === 'object') return rewriteUrlsInPlace(v);
    return v;
}

/* ---------- Shared fetch+cache helper ----------
 * 1. Check in-memory cache for a fresh successful entry.
 * 2. If miss, fetch upstream.
 * 3. If upstream returns 2xx, store it in cache.
 * 4. Non-2xx and network errors are NEVER cached.
 */
async function fetchUpstreamCached(cacheKey, url, referer) {
    const hit = getCache(cacheKey);
    if (hit) {
        return { ...hit, fromCache: true };
    }
    const response = await axios.get(url, {
        headers: buildUpstreamHeaders(referer),
        decompress: true,
        timeout: 15000,
        validateStatus: () => true // pass the real status through
    });
    setCache(cacheKey, response.status, response.data);
    return { status: response.status, data: response.data, fromCache: false };
}

/* ---------- Routes ---------- */

// Health check
app.get('/', (_req, res) => {
    res.json({
        service: 'moviesapi-proxy',
        status: 'running',
        endpoints: {
            movie: '/api/movie/:id',
            tv: '/api/tv/:id/:seasonno/:episodeno',
            cache: '/api/cache/stats'
        },
        cache: cacheStats()
    });
});

// Cache management
app.get('/api/cache/stats', (_req, res) => res.json(cacheStats()));
app.delete('/api/cache', (_req, res) => {
    const cleared = cache.size;
    cache.clear();
    res.json({ result: true, cleared });
});
app.post('/api/cache/invalidate/:key', (req, res) => {
    const existed = cache.has(req.params.key);
    cache.delete(req.params.key);
    res.json({ result: true, existed, key: req.params.key });
});

/**
 * GET /api/movie/:id
 * Proxy to https://moviesapi.to/api/vidora/v1/movie/:id
 */
app.get('/api/movie/:id', async (req, res) => {
    const { id } = req.params;
    const upstreamUrl = `https://moviesapi.to/api/vidora/v1/movie/${id}`;
    const referer = `https://moviesapi.to/movie/${id}?theme=${THEME}`;
    const cacheKey = `movie:${id}`;
    const useWorker = req.query.worker === '1' || req.query.worker === 'true';

    try {
        const result = await fetchUpstreamCached(cacheKey, upstreamUrl, referer);
        res.setHeader('X-Cache', result.fromCache ? 'HIT' : 'MISS');
        res.setHeader('X-Worker', useWorker ? 'ON' : 'OFF');
        const payload = useWorker ? applyWorker(result.data) : result.data;
        return res.status(result.status).json(payload);
    } catch (error) {
        console.error(`[movie/${id}] error:`, error.message);
        return res.status(502).json({
            result: false,
            error: 'Upstream request failed',
            message: error.message,
            upstream: upstreamUrl
        });
    }
});

/**
 * GET /api/tv/:id/:seasonno/:episodeno
 * Proxy to https://moviesapi.to/api/vidora/v1/tv/:id/:seasonno/:episodeno
 */
app.get('/api/tv/:id/:seasonno/:episodeno', async (req, res) => {
    const { id, seasonno, episodeno } = req.params;
    const upstreamUrl = `https://moviesapi.to/api/vidora/v1/tv/${id}/${seasonno}/${episodeno}`;
    const referer = `https://moviesapi.to/tv/${id}/${seasonno}/${episodeno}?theme=${THEME}`;
    const cacheKey = `tv:${id}:${seasonno}:${episodeno}`;
    const useWorker = req.query.worker === '1' || req.query.worker === 'true';

    try {
        const result = await fetchUpstreamCached(cacheKey, upstreamUrl, referer);
        res.setHeader('X-Cache', result.fromCache ? 'HIT' : 'MISS');
        res.setHeader('X-Worker', useWorker ? 'ON' : 'OFF');
        const payload = useWorker ? applyWorker(result.data) : result.data;
        return res.status(result.status).json(payload);
    } catch (error) {
        console.error(`[tv/${id}/${seasonno}/${episodeno}] error:`, error.message);
        return res.status(502).json({
            result: false,
            error: 'Upstream request failed',
            message: error.message,
            upstream: upstreamUrl
        });
    }
});

/* ---------- 404 + global error handler ---------- */
app.use((req, res) => {
    res.status(404).json({
        result: false,
        error: 'Not found',
        available: ['/api/movie/:id', '/api/tv/:id/:seasonno/:episodeno']
    });
});

app.use((err, _req, res, _next) => {
    console.error('Unhandled error:', err);
    res.status(500).json({ result: false, error: 'Internal server error' });
});

/* ---------- Start ---------- */
app.listen(PORT, () => {
    console.log('─────────────────────────────────────────────');
    console.log(`  moviesapi-proxy running on port ${PORT}`);
    console.log(`  Movie : http://localhost:${PORT}/api/movie/:id`);
    console.log(`  TV    : http://localhost:${PORT}/api/tv/:id/:seasonno/:episodeno`);
    console.log(`  Cache : ${CACHE_ENABLED ? 'ON' : 'OFF'} (TTL ${CACHE_TTL_MS}ms)`);
    console.log(`  Worker: ${WORKER_URL}  (pass ?worker=1 to enable)`);
    console.log('─────────────────────────────────────────────');
    if (!XSRF_TOKEN || !VIDSPARK_SESSION) {
        console.log('  ⚠  XSRF_TOKEN / VIDSPARK_SESSION not set.');
        console.log('     Set them as env vars if the upstream starts rejecting requests.');
    }
});
