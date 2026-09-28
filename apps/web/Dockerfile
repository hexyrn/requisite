# Production image for the Hexyrn Core web frontend - builds the static
# Vite bundle and serves it from Caddy (the same reverse-proxy image used
# for TLS termination in docker-compose.prod.yml, so there is only one
# HTTP-serving technology to operate in production, not nginx-for-static
# plus Caddy-for-TLS).
FROM node:20-alpine AS build
WORKDIR /repo
# See apps/api/Dockerfile's equivalent comment: `npm ci` must run AFTER
# the full source is present, not before - confirmed by real execution
# that running it against only partial package.json files makes npm's
# workspace symlinks point at this build host's own absolute path
# (dangling once copied into the image), breaking module resolution for
# @hexyrn/design-system et al.
COPY . .
RUN npm ci
# npm has been seen to crash mid-install ("Exit handler never called") while the
# step still reported success, and BuildKit then caches that empty install and
# every later build fails confusingly with "tsc: not found". Fail right here instead.
RUN test -x node_modules/.bin/tsc || (echo 'npm ci did not install dependencies' >&2; exit 1)
# apps/web depends on the compiled dist/ of these workspace packages
# (@hexyrn/design-system, @hexyrn/shared-types) - same real bug fixed in
# apps/api/Dockerfile (workspace deps must be built before the app that
# consumes them, `npm run build --workspace apps/web` alone does not
# build its own dependencies first).
RUN npm run build --workspace packages/shared-types --workspace packages/design-system
RUN npm run build --workspace apps/web

FROM caddy:2-alpine
COPY --from=build /repo/apps/web/dist /srv
COPY apps/web/docker/Caddyfile /etc/caddy/Caddyfile
