# Docker build of the Portal for Cloudflare (node-ts) on the Bun runtime, for your own server or any
# container host.
# docker build -t brand-portal . && docker run -p 8080:8080 -v portal-data:/data brand-portal
FROM oven/bun:1.4-slim AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

FROM litestream/litestream:0.3.13 AS litestream

FROM oven/bun:1.4-slim
WORKDIR /app
ENV NODE_ENV=production \
    PORT=8080 \
    OBX_DATA_DIR=/data \
    OBX_UI_DIR=/app/public
COPY --from=litestream /usr/local/bin/litestream /usr/local/bin/litestream
COPY --from=deps /app/node_modules ./node_modules
COPY package.json tsconfig.json ./
COPY src ./src
COPY migrations ./migrations
COPY public ./public
COPY deploy/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN mkdir -p /data && chown -R bun:bun /data && chmod +x /usr/local/bin/docker-entrypoint.sh
USER bun
VOLUME ["/data"]
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD bun -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["bun", "src/adapters/bun/main.ts"]
