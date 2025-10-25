# Korone Down Meter

A simple static website you can host with GitHub Pages that checks whether Korone shows the text "site is currently down". When that text is detected the site increments a persistent counter (stored in the user's browser localStorage).

Features:
- Dark, stylized UI
- Counter stored in localStorage so it persists for visitors of the same browser
- Optional CORS proxy input (to work around cross-origin restrictions)

How it works
- The client fetches the target URL (via an optional CORS proxy) and searches for the phrase "site is currently down".
- If the phrase is found and the previous known state wasn't "down", the counter increments by 1 and the UI updates.
- The script polls every 60 seconds by default.

CORS note
- Browsers enforce cross-origin rules which often block direct fetching of third-party pages from a static site.
- The site uses `https://api.allorigins.win/raw?url=` by default as a public CORS proxy. If you prefer another proxy or run your own, set it in the "CORS proxy" field on the page and it will be saved to localStorage.
- If you run this on GitHub Pages and direct fetches are blocked, set the proxy input to a working CORS proxy.

Deployment (GitHub Pages)
1. Create a new repository (or use an existing one).
2. Add the files from this project (`index.html`, `style.css`, `script.js`).
3. (Optional) Add a `logo.png` to the repository root to display your logo.
4. Enable GitHub Pages for the repository (Settings → Pages → Branch: `main` (or `gh-pages`) and / (root)).
5. Visit the published URL. The script will run in visitors' browsers.

Limitations and privacy
- This implementation stores the counter in the visitor's browser (localStorage). That means:
  - The counter is per-browser and not global across users.
  - No server or database is used (keeps it fully static and GitHub Pages-compatible).
- If you want a global counter shared across all visitors you would need a server or a serverless backend (e.g. Netlify Functions, GitHub Actions with a data file, or a small API) to store the count.
