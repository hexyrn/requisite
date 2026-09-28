# Production image for the Hexyrn Core API (P3 item 3/6: Docker deployment).
#
# Multi-stage: builds the whole npm-workspaces monorepo (the api workspace
# depends on packages/* like @hexyrn/design-system is NOT a runtime dep of
# the API, but shared TS config/lint packages may be), then ships only the
# compiled dist/ + production node_modules in the final stage - the
# TypeScript compiler, dev dependencies, and source are never present in
# the image that actually runs, which is both smaller and reduces the
# attack surface of what's on disk in production.
FROM node:20-alpine AS build
WORKDIR /repo

# Deliberately NOT a two-layer "copy manifests, npm ci, then copy source"
# split (the usual Docker-caching pattern) - confirmed by a real `docker
# build` in this phase's development that running `npm ci` while only
# partial package.json files are present makes npm's workspace linker
# create the `node_modules/@hexyrn/*` symlinks pointing at this BUILD
# HOST'S OWN ABSOLUTE FILESYSTEM PATH (e.g. `/home/user/project/packages/
# app-sdk`) instead of a relative path - harmless on the host itself, but
# a dangling symlink once copied into the image's own filesystem, which
# then makes TypeScript fail with "Cannot find module '@hexyrn/app-sdk'"
# during the build below. Copying the full source FIRST and running
# `npm ci` after makes npm create correct RELATIVE symlinks
# (`../../packages/app-sdk`) instead - confirmed fixed by the same real
# `docker build`. This costs some layer-cache efficiency (source changes
# invalidate the install step too) in exchange for actually working.
COPY . .
RUN npm ci
# npm has been seen to crash mid-install ("Exit handler never called") while the
# step still reported success, and BuildKit then caches that empty install and
# every later build fails confusingly with "tsc: not found". Fail right here instead.
RUN test -x node_modules/.bin/tsc || (echo 'npm ci did not install dependencies' >&2; exit 1)

# apps/api depends on the compiled dist/ of these workspace packages
# (@hexyrn/shared-types, @hexyrn/app-sdk) - build them first, found as a
# real bug during a genuine `docker build` of this Dockerfile (api's own
# `tsc` failed with "Cannot find module '@hexyrn/app-sdk'" because only
# api itself was being built, never its workspace dependencies).
RUN npm run build --workspace packages/shared-types --workspace packages/app-sdk
RUN npm run build --workspace apps/api

# Production dependency install (no devDependencies) - separate from the
# build-stage install above, which needed devDependencies (typescript etc.)
# `npm ci` at the repo root (npm workspaces) HOISTS everything into
# /repo/node_modules - there is no separate apps/api/node_modules to copy
# out in isolation (confirmed by real execution: the earlier version of
# this file tried to COPY --from=build /repo/apps/api/node_modules, which
# does not exist, and failed the build outright). The runtime stage below
# therefore keeps the repo's relative layout (/repo/apps/api,
# /repo/packages/*, /repo/node_modules) instead of flattening everything
# into /app, because apps/api's @hexyrn/* dependencies are RELATIVE
# symlinks (../../packages/app-sdk etc., see the npm-ci-ordering comment
# above) that only resolve correctly if that relative structure is
# preserved.
RUN npm ci --omit=dev

FROM node:20-alpine AS runtime
# Deliberately NOT running as root (item 34/production-hardening: a
# container escape or dependency RCE in a root-owned process is a
# materially larger blast radius than in an unprivileged one).
RUN addgroup -S hexyrn && adduser -S hexyrn -G hexyrn
WORKDIR /repo
ENV NODE_ENV=production

COPY --from=build /repo/node_modules ./node_modules
COPY --from=build /repo/package.json ./package.json
COPY --from=build /repo/apps/api/dist ./apps/api/dist
COPY --from=build /repo/apps/api/package.json ./apps/api/package.json
COPY --from=build /repo/apps/api/src/db/migrations ./apps/api/dist/db/migrations
COPY --from=build /repo/packages/app-sdk/dist ./packages/app-sdk/dist
COPY --from=build /repo/packages/app-sdk/package.json ./packages/app-sdk/package.json
COPY --from=build /repo/packages/shared-types/dist ./packages/shared-types/dist
COPY --from=build /repo/packages/shared-types/package.json ./packages/shared-types/package.json

RUN mkdir -p /repo/apps/api/storage /repo/apps/api/backups && chown -R hexyrn:hexyrn /repo
USER hexyrn
WORKDIR /repo/apps/api

EXPOSE 3000
# No HEALTHCHECK baked in here - docker-compose.prod.yml defines it against
# the real /api/v1/health endpoint, keeping the check's exact shape in one
# reviewable place rather than duplicated between the image and compose.
CMD ["node", "dist/main.js"]
