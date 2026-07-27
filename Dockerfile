FROM node:20-alpine AS base

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .

FROM base AS dev
ENV NODE_ENV=development
ENV PORT=8080
ENV HOST=0.0.0.0
RUN npm run wasm:package
EXPOSE 8080
CMD ["npm", "run", "dev"]

FROM node:20-alpine AS prod

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src
COPY public ./public
COPY scripts ./scripts
COPY bundles ./bundles
COPY data ./data
COPY certs ./certs

RUN npm run wasm:package

RUN mkdir -p /app/data /app/bundles && chown -R node:node /app

ENV NODE_ENV=production
ENV PORT=8080
ENV HOST=0.0.0.0

USER node

EXPOSE 8080

CMD ["node", "src/server.js"]
