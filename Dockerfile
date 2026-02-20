# ── Stage 1: Build ──────────────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# ── Stage 2: Production runtime ──────────────────────────────────
FROM node:20-alpine

WORKDIR /app

ENV NODE_ENV=production

COPY package.json package-lock.json ./
# Keep devDependencies so tsx is available for the guardian service
RUN npm ci --ignore-scripts && npm cache clean --force

COPY --from=builder /app/dist ./dist
COPY public/ ./public/
COPY scripts/ ./scripts/
COPY tsconfig.json ./
COPY entrypoint.sh ./
RUN chmod +x entrypoint.sh

# SERVICE_TYPE=guardian → runs wallet-guardian.ts via tsx
# SERVICE_TYPE unset    → runs compiled API server
CMD ["./entrypoint.sh"]
