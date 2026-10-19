FROM node:22-alpine

# zip/unzip per importare ed esportare i mondi
RUN apk add --no-cache zip unzip

WORKDIR /app
COPY package.json server.js ./
COPY public ./public

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8080

EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -qO- "http://127.0.0.1:${PORT}/healthz" || exit 1

# Gira come root perché deve usare il socket Docker montato da fuori.
CMD ["node", "server.js"]
