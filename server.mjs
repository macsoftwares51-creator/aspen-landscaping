import http from 'node:http';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));

if (existsSync(path.join(root, '.env'))) {
    for (const line of readFileSync(path.join(root, '.env'), 'utf8').split(/\r?\n/)) {
        const match = line.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/);
        if (match && !process.env[match[1]]) {
            process.env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
        }
    }
}

const port = Number(process.env.PORT || 3000);
const githubApi = 'https://api.github.com';
const reviewPath = 'reviews.json';
const reviewRateLimits = new Map();
const loginRateLimits = new Map();
const adminCookieName = 'aspen_admin_session';

function sendJson(response, status, payload) {
    response.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff'
    });
    response.end(JSON.stringify(payload));
}

function hasAdminConfig() {
    return Boolean(process.env.ADMIN_PASSWORD && process.env.ADMIN_SESSION_SECRET);
}

function createAdminSession() {
    const payload = Buffer.from(JSON.stringify({ expiresAt: Date.now() + 8 * 60 * 60 * 1000 })).toString('base64url');
    const signature = createHmac('sha256', process.env.ADMIN_SESSION_SECRET).update(payload).digest('base64url');
    return `${payload}.${signature}`;
}

function isAdminAuthenticated(request) {
    if (!hasAdminConfig()) return false;
    const cookies = Object.fromEntries((request.headers.cookie || '').split(';').map((part) => {
        const separator = part.indexOf('=');
        return separator < 0 ? ['', ''] : [part.slice(0, separator).trim(), part.slice(separator + 1).trim()];
    }));
    const [payload, suppliedSignature, extra] = (cookies[adminCookieName] || '').split('.');
    if (!payload || !suppliedSignature || extra) return false;
    const expectedSignature = createHmac('sha256', process.env.ADMIN_SESSION_SECRET).update(payload).digest();
    const actualSignature = Buffer.from(suppliedSignature, 'base64url');
    if (actualSignature.length !== expectedSignature.length || !timingSafeEqual(actualSignature, expectedSignature)) return false;
    try {
        return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')).expiresAt > Date.now();
    } catch {
        return false;
    }
}

function loginPage() {
    const setupMessage = hasAdminConfig()
        ? ''
        : '<p class="warning">Admin access is not configured. Set ADMIN_PASSWORD and ADMIN_SESSION_SECRET on the server.</p>';
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Admin Login | Aspen Leaf Scape Ltd</title><style>
        *{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f3f5ef;color:#1f2937;font:16px system-ui,sans-serif;padding:20px}.panel{width:min(100%,420px);background:#fff;border:1px solid #dfe7e1;border-top:5px solid #1e3a2b;border-radius:16px;padding:28px;box-shadow:0 20px 50px #0f172a20}h1{font-size:22px;color:#1e3a2b;margin:0 0 8px}p{font-size:14px;color:#64748b}label{display:block;font-size:13px;font-weight:700;margin:22px 0 6px}input{width:100%;padding:12px;border:1px solid #cbd5e1;border-radius:8px;font-size:16px}button{width:100%;margin-top:16px;padding:12px;background:#1e3a2b;color:#fff;border:0;border-radius:8px;font-weight:700;font-size:14px;cursor:pointer}button:disabled{opacity:.6}.status{min-height:20px;color:#9f1239}.warning{background:#fff7ed;color:#9a3412;padding:10px;border-radius:8px}
        </style></head><body><main class="panel"><h1>Aspen Leaf Scape Ltd</h1><p>Sign in to site administration.</p>${setupMessage}<form id="login-form"><label for="password">Admin password</label><input id="password" name="password" type="password" autocomplete="current-password" required><button type="submit">Sign in</button><p class="status" id="status" role="status"></p></form><a href="/" style="font-size:13px;color:#1e3a2b">Back to home</a></main><script>
        document.getElementById('login-form').addEventListener('submit',async event=>{event.preventDefault();const button=event.currentTarget.querySelector('button');const status=document.getElementById('status');button.disabled=true;status.textContent='Signing in...';try{const response=await fetch('/api/admin/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:document.getElementById('password').value})});const result=await response.json();if(!response.ok)throw new Error(result.error||'Sign in failed.');location.assign('/admin.html')}catch(error){status.textContent=error.message}finally{button.disabled=false}});
        </script></body></html>`;
}

function sendAdminCookie(response, request, token) {
    const secure = process.env.NODE_ENV === 'production' || request.socket.encrypted;
    const attributes = `Path=/; HttpOnly; SameSite=Strict; Max-Age=${token ? 28800 : 0}${secure ? '; Secure' : ''}`;
    response.setHeader('Set-Cookie', `${adminCookieName}=${token || ''}; ${attributes}`);
}

function adminLoginRateLimited(request) {
    const address = request.socket.remoteAddress || 'unknown';
    const now = Date.now();
    const windowMs = 15 * 60 * 1000;
    const entry = loginRateLimits.get(address);
    if (!entry || now - entry.startedAt >= windowMs) {
        loginRateLimits.set(address, { startedAt: now, count: 1 });
        return false;
    }
    entry.count += 1;
    return entry.count > 8;
}

function hasGitHubConfig() {
    return Boolean(process.env.GITHUB_TOKEN && process.env.GITHUB_OWNER && process.env.GITHUB_REPO);
}

function githubHeaders() {
    return {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
        'X-GitHub-Api-Version': '2022-11-28'
    };
}

function contentsUrl() {
    const owner = encodeURIComponent(process.env.GITHUB_OWNER);
    const repo = encodeURIComponent(process.env.GITHUB_REPO);
    return `${githubApi}/repos/${owner}/${repo}/contents/${reviewPath}`;
}

async function readReviews() {
    const response = await fetch(contentsUrl(), { headers: githubHeaders() });
    if (response.status === 404) return { reviews: [], sha: null };
    if (!response.ok) throw new Error(`GitHub read failed (${response.status}).`);
    const file = await response.json();
    const reviews = JSON.parse(Buffer.from(file.content.replace(/\s/g, ''), 'base64').toString('utf8'));
    if (!Array.isArray(reviews)) throw new Error('The repository review file is not a list.');
    return { reviews, sha: file.sha };
}

function rateLimited(request) {
    const address = request.socket.remoteAddress || 'unknown';
    const now = Date.now();
    const windowMs = 10 * 60 * 1000;
    const entry = reviewRateLimits.get(address);
    if (!entry || now - entry.startedAt >= windowMs) {
        reviewRateLimits.set(address, { startedAt: now, count: 1 });
        return false;
    }
    entry.count += 1;
    return entry.count > 5;
}

async function readRequestBody(request) {
    let body = '';
    for await (const chunk of request) {
        body += chunk;
        if (body.length > 8192) throw new Error('Review submission is too large.');
    }
    return JSON.parse(body || '{}');
}

async function saveReview(review) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
        const current = await readReviews();
        const reviews = [review, ...current.reviews].slice(0, 5000);
        const content = Buffer.from(`${JSON.stringify(reviews, null, 2)}\n`).toString('base64');
        const response = await fetch(contentsUrl(), {
            method: 'PUT',
            headers: { ...githubHeaders(), 'Content-Type': 'application/json' },
            body: JSON.stringify({
                message: 'Add customer review',
                content,
                ...(current.sha ? { sha: current.sha } : {})
            })
        });
        if (response.ok) return;
        if (response.status !== 409 && response.status !== 422) {
            throw new Error(`GitHub write failed (${response.status}).`);
        }
    }
    throw new Error('Reviews are busy being updated. Please try again shortly.');
}

const server = http.createServer(async (request, response) => {
    const requestUrl = new URL(request.url, `http://${request.headers.host || 'localhost'}`);

    if (requestUrl.pathname === '/api/admin/session' && request.method === 'GET') {
        if (!hasAdminConfig()) return sendJson(response, 503, { error: 'Admin access is not configured.' });
        if (!isAdminAuthenticated(request)) return sendJson(response, 401, { error: 'Authentication required.' });
        return sendJson(response, 200, { authenticated: true });
    }

    if (requestUrl.pathname === '/api/admin/login' && request.method === 'POST') {
        if (!hasAdminConfig()) return sendJson(response, 503, { error: 'Admin access is not configured.' });
        if (adminLoginRateLimited(request)) return sendJson(response, 429, { error: 'Too many sign-in attempts. Try again later.' });
        try {
            const body = await readRequestBody(request);
            const candidate = Buffer.from(typeof body.password === 'string' ? body.password : '');
            const expected = Buffer.from(process.env.ADMIN_PASSWORD);
            const passwordMatches = candidate.length === expected.length && timingSafeEqual(candidate, expected);
            if (!passwordMatches) return sendJson(response, 401, { error: 'Incorrect password.' });
            const token = createAdminSession();
            sendAdminCookie(response, request, token);
            return sendJson(response, 200, { ok: true });
        } catch {
            return sendJson(response, 400, { error: 'Invalid sign-in request.' });
        }
    }

    if (requestUrl.pathname === '/api/admin/logout' && request.method === 'POST') {
        sendAdminCookie(response, request, '');
        return sendJson(response, 200, { ok: true });
    }

    if (requestUrl.pathname === '/api/reviews' && request.method === 'GET') {
        if (!hasGitHubConfig()) return sendJson(response, 503, { error: 'Review service is not configured yet.' });
        try {
            const { reviews } = await readReviews();
            return sendJson(response, 200, { reviews });
        } catch (error) {
            console.error(error);
            return sendJson(response, 502, { error: 'Could not load reviews from GitHub.' });
        }
    }

    if (requestUrl.pathname === '/api/reviews' && request.method === 'POST') {
        if (!hasGitHubConfig()) return sendJson(response, 503, { error: 'Review service is not configured yet.' });
        if (rateLimited(request)) return sendJson(response, 429, { error: 'Too many submissions. Please try again later.' });
        try {
            const body = await readRequestBody(request);
            if (typeof body.website === 'string' && body.website.trim()) return sendJson(response, 200, { ok: true });
            const name = typeof body.name === 'string' ? body.name.trim().slice(0, 60) : '';
            const message = typeof body.message === 'string' ? body.message.trim().slice(0, 1200) : '';
            const rating = Number(body.rating);
            if (name.length < 2 || message.length < 10 || !Number.isInteger(rating) || rating < 1 || rating > 5) {
                return sendJson(response, 400, { error: 'Enter your name, a 1–5 star rating, and a review of at least 10 characters.' });
            }
            const review = { id: crypto.randomUUID(), name, rating, message, createdAt: new Date().toISOString() };
            await saveReview(review);
            return sendJson(response, 201, { ok: true, review });
        } catch (error) {
            if (error instanceof SyntaxError || error.message.includes('too large')) {
                return sendJson(response, 400, { error: 'Please submit a valid review.' });
            }
            console.error(error);
            return sendJson(response, 502, { error: 'Could not save your review to GitHub. Please try again later.' });
        }
    }

   if (requestUrl.pathname === '/api/admin/settings' && request.method === 'POST') {
        if (!isAdminAuthenticated(request)) return sendJson(response, 401, { error: 'Authentication required.' });
        if (!hasGitHubConfig()) return sendJson(response, 503, { error: 'GitHub config missing on server.' });
        try {
            const body = await readRequestBody(request);
            const settingsPath = 'site-data.json';
            const owner = encodeURIComponent(process.env.GITHUB_OWNER);
            const repo = encodeURIComponent(process.env.GITHUB_REPO);
            const endpoint = `${githubApi}/repos/${owner}/${repo}/contents/${settingsPath}`;
            
            // Check if file already exists to get its SHA
            const existing = await fetch(endpoint, { headers: githubHeaders() });
            let sha = null;
            if (existing.ok) {
                const fileData = await existing.json();
                sha = fileData.sha;
            } else if (existing.status !== 404) {
                const errText = await existing.text();
                console.error('GitHub check failed:', existing.status, errText);
            }

            const content = Buffer.from(JSON.stringify(body, null, 2)).toString('base64');
            const responsePayload = await fetch(endpoint, {
                method: 'PUT',
                headers: { ...githubHeaders(), 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    message: 'Admin Update: Site Settings',
                    content,
                    ...(sha ? { sha } : {})
                })
            });

            if (!responsePayload.ok) {
                const errorDetails = await responsePayload.text();
                console.error('GitHub write error response:', errorDetails);
                throw new Error(`GitHub write failed (${responsePayload.status}).`);
            }

            return sendJson(response, 200, { ok: true });
        } catch (error) {
            console.error('Settings publish error:', error);
            return sendJson(response, 502, { error: error.message || 'Could not publish to GitHub.' });
        }
    }
    
    if (requestUrl.pathname === '/api/service-images' && request.method === 'GET') {
        try {
            const pictureRoot = path.join(root, 'pictures');
            const folderEntries = await readdir(pictureRoot, { withFileTypes: true });
            const folders = {};
            for (const folder of folderEntries.filter((entry) => entry.isDirectory())) {
                const files = await readdir(path.join(pictureRoot, folder.name), { withFileTypes: true });
                folders[folder.name] = files
                    .filter((file) => file.isFile() && /\.(?:avif|gif|jpe?g|png|webp)$/i.test(file.name))
                    .map((file) => `/pictures/${encodeURIComponent(folder.name)}/${encodeURIComponent(file.name)}`)
                    .sort();
            }
            return sendJson(response, 200, { folders });
        } catch (error) {
            console.error(error);
            return sendJson(response, 500, { error: 'Could not load service pictures.' });
        }
    }

    if (request.method !== 'GET' && request.method !== 'HEAD') {
        return sendJson(response, 405, { error: 'Method not allowed.' });
    }

    let page;
    try {
        page = requestUrl.pathname === '/' ? 'index.html' : decodeURIComponent(requestUrl.pathname.slice(1));
    } catch {
        response.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
        return response.end('Invalid path');
    }
    const imageAssets = new Set([
        'assets/aspen-leaf-logo.jpeg',
        'assets/aspen-leaf-logo-hero.png',
    ]);
    const servicePicture = /^pictures\/[A-Za-z0-9 _-]+\/[A-Za-z0-9._-]+\.(?:avif|gif|jpe?g|png|webp)$/i.test(page);
    const serviceImageManifest = page === 'pictures/service-images.json';
    const staticReviews = page === 'reviews.json';
    if (!['index.html', 'admin.html'].includes(page) && !imageAssets.has(page) && !servicePicture && !serviceImageManifest && !staticReviews) {
        response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        return response.end('Not found');
    }
    if (page === 'admin.html' && !isAdminAuthenticated(request)) {
        response.writeHead(200, {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'no-store',
            'X-Content-Type-Options': 'nosniff',
            'Referrer-Policy': 'no-referrer'
        });
        return response.end(loginPage());
    }
    try {
        const content = await readFile(path.join(root, page));
        const extension = path.extname(page).toLowerCase();
        response.writeHead(200, {
            'Content-Type': serviceImageManifest || staticReviews ? 'application/json; charset=utf-8' : extension === '.png' ? 'image/png' : extension === '.webp' ? 'image/webp' : extension === '.avif' ? 'image/avif' : extension === '.gif' ? 'image/gif' : imageAssets.has(page) || servicePicture ? 'image/jpeg' : 'text/html; charset=utf-8',
            ...(page === 'admin.html' ? { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' } : {}),
            'X-Content-Type-Options': 'nosniff',
            'Referrer-Policy': 'strict-origin-when-cross-origin'
        });
        response.end(request.method === 'HEAD' ? undefined : content);
    } catch {
        response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        response.end('Not found');
    }
});

server.listen(port, process.env.HOST || '0.0.0.0', () => {
    console.log(`Aspen Leaf Scape site listening on port ${port}`);
});
