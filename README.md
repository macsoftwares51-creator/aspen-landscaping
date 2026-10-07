# Aspen Leaf Scape site

## Run locally

Requires Node.js 20 or newer. Copy `.env.example` to `.env`, then set:

- `GITHUB_TOKEN`: a fine-grained GitHub token with Contents read/write access to the target repository
- `GITHUB_OWNER`: the repository owner
- `GITHUB_REPO`: the repository name
- `PORT`: optional; defaults to `3000`

Keep `.env` private. It is excluded from Git. Start the site with `npm start` and open `http://localhost:3000`.

The customer review form uses the server's `/api/reviews` endpoint. Reviews are appended to `reviews.json` in the configured repository through the GitHub Contents API. The token stays on the server and is never sent to visitors' browsers.

## Deploy

Deploy the Node.js app to a host that supports persistent Node server processes, and set the same variables as server-side environment secrets. GitHub Pages alone cannot run this API endpoint. Point the domain at the Node app so the site and `/api/reviews` share the same origin.