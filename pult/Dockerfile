FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

FROM node:22-alpine AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:22-alpine AS tools
ARG TARGETARCH
ARG BUF_VERSION=1.74.0
ARG OASDIFF_VERSION=1.34.0
RUN apk add --no-cache curl tar \
  && case "$TARGETARCH" in \
       amd64) BUF_ARCH=x86_64 ;; \
       arm64) BUF_ARCH=aarch64 ;; \
       *) echo "неподдерживаемая архитектура $TARGETARCH" >&2; exit 1 ;; \
     esac \
  && curl -fsSL -o /usr/local/bin/buf "https://github.com/bufbuild/buf/releases/download/v${BUF_VERSION}/buf-Linux-${BUF_ARCH}" \
  && chmod +x /usr/local/bin/buf \
  && curl -fsSL "https://github.com/oasdiff/oasdiff/releases/download/v${OASDIFF_VERSION}/oasdiff_${OASDIFF_VERSION}_linux_${TARGETARCH}.tar.gz" \
    | tar -xz -C /usr/local/bin oasdiff

FROM build AS live
RUN apk add --no-cache libxml2-utils
COPY --from=tools /usr/local/bin/buf /usr/local/bin/oasdiff /usr/local/bin/
ENTRYPOINT ["npx", "tsx", "--test"]
CMD ["src/**/*.live.ts"]

FROM node:22-alpine
RUN apk add --no-cache docker-cli docker-cli-compose libxml2-utils
COPY --from=tools /usr/local/bin/buf /usr/local/bin/oasdiff /usr/local/bin/
WORKDIR /app
ENV NODE_ENV=production
COPY --from=dependencies /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
ENTRYPOINT ["node", "/app/dist/main.js"]
