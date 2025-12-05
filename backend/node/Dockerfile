# backend/node/Dockerfile
FROM node:18-alpine

WORKDIR /app

# copy package files first to leverage cache
COPY package*.json ./

# install all dependencies including dev (we need typescript to build)
RUN npm ci --include=dev

# copy source
COPY . .

# build TypeScript to /app/dist
RUN npm run build

# remove dev deps to keep image smaller (optional)
RUN npm prune --production

# run the compiled server
CMD ["node", "dist/server.js"]
