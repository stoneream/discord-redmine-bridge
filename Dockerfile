FROM node:26-bookworm-slim
WORKDIR /app

COPY package.json pnpm-lock.yaml ./
RUN npm install --global pnpm@12.15.0 \
    && pnpm install --prod --frozen-lockfile

COPY src ./src
ENV NODE_ENV=production
USER node
CMD ["node", "src/index.ts"]
