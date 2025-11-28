# -----------------------------------------------------------------------------
# Multi-stage build for the traffic simulation webapp
# 1) Build stage installs deps and runs the production build
# 2) Runtime stage serves the static dist with a lightweight server
# -----------------------------------------------------------------------------
FROM node:20-alpine AS build
WORKDIR /app

# Install build dependencies
COPY package*.json ./
RUN npm ci

# Build
COPY . .
RUN npm run build

# -----------------------------------------------------------------------------
FROM node:20-alpine AS runner
WORKDIR /app

# Lightweight static server
RUN npm install -g serve@14

# Copy built assets
COPY --from=build /app/dist ./dist

EXPOSE 4173

# Default port matches Vite preview / serve default overrideable via PORT env
ENV PORT=4173

CMD ["serve", "-s", "dist", "-l", "4173"]
