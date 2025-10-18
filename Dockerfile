FROM node:22-slim AS builder
WORKDIR /app

ENV PUPPETEER_CACHE_DIR=/root/.cache/puppeteer

COPY package*.json ./
COPY scripts ./scripts
RUN npm ci

COPY . .
RUN npm run build
RUN npm prune --production

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
ENV TRANSPORT=http
ENV PUPPETEER_CACHE_DIR=/root/.cache/puppeteer
ENV SMITHERY_CONFIG=smithery.config.mjs
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    fonts-liberation \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libcairo2 \
    libcups2 \
    libdbus-1-3 \
    libdrm2 \
    libexpat1 \
    libfontconfig1 \
    libgbm1 \
    libglib2.0-0 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libpango-1.0-0 \
    libpangocairo-1.0-0 \
    libstdc++6 \
    libx11-6 \
    libx11-xcb1 \
    libxcb1 \
    libxcomposite1 \
    libxcursor1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxi6 \
    libxkbcommon0 \
    libxrandr2 \
    libxrender1 \
    libxshmfence1 \
    libxss1 \
    libxtst6 \
    wget \
    xdg-utils \
 && rm -rf /var/lib/apt/lists/*

COPY --from=builder /app/package*.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/build ./build
COPY --from=builder /app/smithery.yaml ./smithery.yaml
COPY --from=builder /app/smithery.config.mjs ./smithery.config.mjs
COPY --from=builder /app/LICENSE ./LICENSE
COPY --from=builder /root/.cache/puppeteer /root/.cache/puppeteer

EXPOSE 8081
CMD ["node", "build/src/index.js"]
