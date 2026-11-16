FROM node:22-bookworm-slim AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src/ src/
RUN npm run build

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0
COPY package.json package-lock.json repositories.example.json ./
RUN npm ci --omit=dev && mkdir data && chown node:node data
COPY --from=builder /app/dist dist
USER node
EXPOSE 3040
CMD ["node", "dist/main.js"]
