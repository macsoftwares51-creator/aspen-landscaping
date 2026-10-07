import http from 'node:http';
import { readFile } from 'node:fs/promises';
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

function sendJson(response, status, payload) {
    response.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff'
    });
    response.end(JSON.stringify(payload));
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

    if (request.method !== 'GET' && request.method !== 'HEAD') {
        return sendJson(response, 405, { error: 'Method not allowed.' });
    }

    const page = requestUrl.pathname === '/' ? 'landscaping_fullstack_application.html' : requestUrl.pathname.slice(1);
    if (!['landscaping_fullstack_application.html', 'admin.html'].includes(page)) {
        response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        return response.end('Not found');
    }
    try {
        const content = await readFile(path.join(root, page));
        response.writeHead(200, {
            'Content-Type': 'text/html; charset=utf-8',
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