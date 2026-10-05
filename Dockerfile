FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json schema.sql ./
COPY src ./src
COPY scripts ./scripts
RUN npm run build:api

FROM node:22-alpine AS web
WORKDIR /app/web
COPY web/package*.json ./
RUN npm ci
COPY web ./
RUN npm run build

FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
ENV NODE_ENV=production
ENV PORT=3001
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
COPY --from=web /app/web/dist ./web/dist
USER node
EXPOSE 3001
CMD ["node", "dist/src/server.js"]
