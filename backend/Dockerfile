# The API on Render (docs/DEPLOY.md). Build context: this folder.
# Bun is pinned: the lockfile needs 1.4 or later, and this is the version the tests run on.
FROM oven/bun:1.4.4-slim

WORKDIR /app

# Dependencies first, so a code-only change reuses this layer. --production skips the test tools.
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

# The server, its scripts (preflight, migrations, the staff CLI: run them from Render's shell) and the PDF fonts.
COPY index.ts tsconfig.json bunfig.toml ./
COPY src ./src
COPY scripts ./scripts
COPY assets ./assets

# Not root. NODE_ENV and everything else come from the service's environment: nothing is baked in.
USER bun
EXPOSE 10000
CMD ["bun", "index.ts"]
