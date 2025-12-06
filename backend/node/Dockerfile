# backend/node/Dockerfile (minimal Playwright support)
FROM node:18-bullseye-slim

WORKDIR /app

# Install minimal OS deps Playwright needs
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    wget \
    gnupg \
    libnss3 \
    libxss1 \
    libasound2 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libcups2 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    libgbm1 \
    libgtk-3-0 \
    libpangocairo-1.0-0 \
    libx11-xcb1 \
    fonts-liberation \
    libepoxy0 \
    python3 \
  && rm -rf /var/lib/apt/lists/*

# copy package files first to leverage cache
COPY package*.json ./

# install all dependencies including dev (we need typescript to build)
RUN npm ci --include=dev

# copy source
COPY . .

# Build TypeScript to /app/dist
RUN npm run build

# Install Playwright browsers (with deps). Minimal, safe single command.
# This installs the browsers used by Playwright into the image.
RUN npx playwright install --with-deps

# remove dev deps to keep image smaller (optional)
RUN npm prune --production

# run the compiled server (same as you had)
CMD ["node", "dist/server.js"]
