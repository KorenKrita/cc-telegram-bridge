FROM node:20-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src/ src/
RUN npm run build

FROM node:20-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist dist/
COPY scripts/ scripts/

ENV NODE_ENV=production
ENTRYPOINT ["node", "dist/src/index.js"]
