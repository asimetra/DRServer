# For deploying this server somewhere, not for working on it.
#
# docker-compose.yml says why the server itself is normally not containerised:
# the client runs natively against 127.0.0.1 and the edit-restart-play loop is
# measured in seconds, which an image rebuild would ruin. That reasoning holds
# for development and stops at the point somebody else wants to run this.
#
#   docker build -t open-dungeon-server .
#   docker run --rm -p 127.0.0.1:8080:8080 -p 127.0.0.1:7198:7198 \
#     -e ODS_PUBLIC_HOST=<the address players resolve> \
#     -e ODS_ALLOW_INSECURE_REMOTE=1 \
#     -e ODS_STORAGE=postgres -e ODS_DATABASE_URL=<url> \
#     -v ods-data:/app/data open-dungeon-server
#
# That acknowledgement is required and is not a formality. A container has to
# bind 0.0.0.0 — loopback inside it means nothing can reach it — so the guard in
# preflight.js fires every time, and it is right to: the ports are cleartext,
# and `-p 127.0.0.1:...` above is what keeps them off the network. Publish them
# anywhere else and a session token is readable by anyone on the path. Put TLS
# or a tunnel in front before that.
#
# Podman ignores the HEALTHCHECK below unless it is told to build a Docker
# image: `podman build --format docker`. The check is still there for anything
# reading /healthz itself.
#
# Nothing is baked in: no compatibility data, no client, no assets. Those are
# supplied at run time from a copy the operator is lawfully entitled to use —
# see README.md and NOTICE.md — which is also why `local-data/` and `content/`
# are excluded in .dockerignore rather than copied.
FROM node:22-alpine

# dumb-init so a Ctrl-C or a container stop reaches node as a signal rather than
# killing PID 1 outright: the server closes sockets and flushes saves on the way
# down, and a SIGKILL is the one shutdown that loses an account write.
RUN apk add --no-cache dumb-init

WORKDIR /app

# Dependencies on their own layer, so a source change does not reinstall them.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

# Not root. The data directory is the only thing written at run time, and it is
# a mount point in practice; made here so an unmounted run still starts.
RUN mkdir -p /app/data && chown -R node:node /app/data
USER node

# Loopback is the right default on a host and the wrong one in a container,
# where it means "unreachable". The operator still has to set ODS_PUBLIC_HOST
# to an address the client can resolve; the startup log prints what it chose.
ENV ODS_HOST=0.0.0.0 \
    ODS_DATA_DIR=/app/data \
    NODE_ENV=production

# 8082 is the status listener. It stays on loopback inside the container, which
# is where the HEALTHCHECK below reads it from; a Prometheus outside needs
# ODS_STATUS_HOST=0.0.0.0 and should reach it over a private network only —
# /players names who is online.
EXPOSE 8080 7198 8082

# The status listener answers before anything else does, so it is the honest
# readiness signal — /healthz checks web, socket, storage, saves and workers.
# On whatever port ODS_STATUS_PORT moved it to: a fixed 8082 read a server on
# another port as unhealthy for as long as it ran.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.ODS_STATUS_PORT||process.env.DR_STATUS_PORT||8082)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "src/index.js"]
