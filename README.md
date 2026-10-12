# Aspen Leaf Scape site

## Run locally

Requires Node.js 20 or newer. Copy `.env.example` to `.env`, then set:

- `GITHUB_TOKEN`: a fine-grained GitHub token with Contents read/write access to the target repository
- `GITHUB_OWNER`: the repository owner
- `GITHUB_REPO`: the repository name
- `ADMIN_PASSWORD`: a strong private password for the admin page
- `ADMIN_SESSION_SECRET`: a long, random secret used to sign admin sessions
- `CLOUDINARY_URL` or `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET`: optional Cloudinary credentials for admin image uploads; use one format or the other
- `PORT`: optional; defaults to `3000`

Keep `.env` private. It is excluded from Git. Admin access is protected by a server-checked password and an eight-hour, signed, HTTP-only session cookie. Run the site with `npm start` and open `http://localhost:3000` (do not open `admin.html` directly as a file).

The customer review form uses the server's `/api/reviews` endpoint. Reviews are appended to `reviews.json` in the configured repository through the GitHub Contents API. The token stays on the server and is never sent to visitors' browsers.

## Deploy

Deploy the Node.js app to a host that supports persistent Node server processes, and set the same variables as server-side environment secrets. Set `NODE_ENV=production` to enable the secure-only session cookie. GitHub Pages alone cannot run this API endpoint or protect the admin page. Point the domain at the Node app so the site and `/api/reviews` share the same origin.
