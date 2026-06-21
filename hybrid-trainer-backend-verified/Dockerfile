# ============================================================================
# Multi-stage build kept deliberately simple — this app has no native
# dependencies left (bcryptjs is pure JS, see ARCHITECTURE.md), so there's
# no compilation step to worry about inside the container, unlike the
# native-bcrypt issue that came up during local testing.
# ============================================================================

FROM node:20-slim

WORKDIR /app

# Copy only package files first so Docker can cache the npm install layer
# — rebuilds where only your route code changed won't re-run npm install.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

# Fly.io sets PORT itself at runtime via fly.toml's internal_port — this
# EXPOSE is documentation for humans/tools reading the Dockerfile, not
# something Fly.io strictly requires to route traffic.
EXPOSE 3000

CMD ["node", "src/server.js"]
