FROM node:22-slim AS builder
WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build
RUN npm prune --production

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
ENV TRANSPORT=http

COPY --from=builder /app/package*.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/build ./build
COPY --from=builder /app/smithery.yaml ./smithery.yaml
COPY --from=builder /app/LICENSE ./LICENSE

EXPOSE 8081
CMD ["node", "build/src/index.js"]
