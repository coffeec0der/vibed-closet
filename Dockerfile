# Home Assistant add-on build (also works with plain `docker build .`).
# Settings come from the add-on options (see config.yaml / ha/run.sh), so this
# file never needs editing. The generic image build lives in docker/Dockerfile.

# Build stage
FROM node:22 AS builder
WORKDIR /app
COPY package*.json ./
COPY patches ./patches
RUN npm ci
COPY src ./src
COPY views ./views
COPY public ./public
COPY tsconfig*.json nest-cli.json tailwind.config.js workbox-config.js ./
RUN npm run build

# Runtime stage
FROM node:22-slim
WORKDIR /app
COPY package*.json ./
COPY patches ./patches
RUN npm ci
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/views ./views
COPY --from=builder /app/public ./public
COPY ha/run.sh /app/ha/run.sh
ENV NODE_ENV=production
# Keep data in the add-on's persistent /data (included in HA backups).
RUN rm -rf /app/data && ln -s /data /app/data
EXPOSE 3000
CMD [ "sh", "/app/ha/run.sh" ]
