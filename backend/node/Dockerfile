# backend/node/Dockerfile (minimal changes)
FROM node:18-bullseye-slim

WORKDIR /app

# Allow skipping Puppeteer's browser download during npm install
ENV PUPPETEER_SKIP_DOWNLOAD=true
# If you want to persist Playwright browsers in a volume, set this env
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

# Install minimal OS deps Playwright needs
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates wget gnupg libnss3 libxss1 libasound2 libatk1.0-0 \
    libatk-bridge2.0-0 libcups2 libxcomposite1 libxdamage1 libxrandr2 \
    libgbm1 libgtk-3-0 libpangocairo-1.0-0 libx11-xcb1 fonts-liberation \
    libepoxy0 python3 \
  && rm -rf /var/lib/apt/lists/*

# copy package files first to leverage cache
COPY package*.json ./

# install all dependencies including dev (we need typescript to build)
RUN npm ci --include=dev

# copy source
COPY . .

# build TypeScript to /app/dist
RUN npm run build

# install only chromium (faster)
RUN npx playwright install chromium

# remove dev deps to keep image smaller (optional)
RUN npm prune --production

# run the compiled server
CMD ["node", "dist/server.js"]
