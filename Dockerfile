FROM node:22-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:22-slim
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*
RUN mkdir -p /data /app/uploads && chown -R node:node /data /app/uploads
ENV NODE_ENV=production PORT=8787 UPLOAD_DIR=/data/uploads
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./
VOLUME /data
EXPOSE 8787
USER node
CMD ["node", "dist/server/server/index.js"]
