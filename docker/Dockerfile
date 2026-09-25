# Pre-built sandbox image: Node 18 + Vite, non-root, no build tools needed at runtime.
# Build once:  docker build -t node18-alpine-vite:latest ./docker
FROM node:18-alpine

# node:18-alpine already ships a `node` user at uid/gid 1000, which would make
# `adduser -u 1000` fail silently and leave the image without a sandbox user.
# Remove it first, then claim uid 1000 for `sandbox`.
RUN apk add --no-cache tini bash git \
 && deluser --remove-home node 2>/dev/null || true \
 && delgroup node 2>/dev/null || true \
 && addgroup -g 1000 -S sandbox \
 && adduser  -u 1000 -S sandbox -G sandbox -h /home/sandbox \
 && mkdir -p /home/sandbox/app \
 && chown -R 1000:1000 /home/sandbox \
 && getent passwd sandbox

# Warm the global cache so `npm create vite` / `npm run dev` work offline-ish.
RUN npm install -g vite@5 --unsafe-perm && npm cache clean --force

USER sandbox
WORKDIR /home/sandbox/app
ENV HOME=/home/sandbox NPM_CONFIG_CACHE=/tmp/.npm HOST=0.0.0.0
EXPOSE 5173

# tini reaps zombie PIDs inside the container (npm spawns lots of children).
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["tail", "-f", "/dev/null"]
