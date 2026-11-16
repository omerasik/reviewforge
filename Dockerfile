FROM node:22-bookworm-slim AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src/ src/
COPY web/ web/
RUN npm run build

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0
COPY package.json package-lock.json repositories.example.json ./
RUN npm ci --omit=dev && mkdir data && chown node:node data
COPY --from=builder /app/dist dist
COPY --from=builder /app/web/dist web/dist
USER node
EXPOSE 3040
HEALTHCHECK CMD ["node", "-e", "fetch('http://127.0.0.1:3040/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
CMD ["node", "dist/main.js"]
