# Stage 1: Base Image
FROM node:22-alpine AS base
WORKDIR /app
RUN apk add --no-cache libc6-compat openssl
COPY package*.json ./

# Stage 2: Dependencies & Build
FROM base AS builder
WORKDIR /app
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build
# Prune devDependencies for lean runtime
RUN npm prune --production

# Stage 3: Production Runtime
FROM base AS runner
WORKDIR /app
ENV NODE_ENV=production

# Security: run as non-root user
USER node

# Copy built application and production dependencies
COPY --chown=node:node --from=builder /app/package*.json ./
COPY --chown=node:node --from=builder /app/node_modules ./node_modules
COPY --chown=node:node --from=builder /app/dist ./dist

EXPOSE 3000

CMD ["node", "dist/api/server.js"]
