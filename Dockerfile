# Playwright's own image ships Chromium plus every system library it needs, which
# Render's native Node runtime cannot install (no apt, no root during build).
# The tag must track the playwright version in package-lock.json — a mismatch
# means the bundled browser build does not match the client and launches fail.
FROM mcr.microsoft.com/playwright:v1.58.2-noble

WORKDIR /app

# Browsers are already in the image at PLAYWRIGHT_BROWSERS_PATH; the postinstall
# download would just fetch a second copy.
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

CMD ["node", "dist/run-job-search.js"]
