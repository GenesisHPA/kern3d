FROM node:22-alpine
ENV NODE_ENV=production DATA_DIR=/data
WORKDIR /app
COPY package.json ./
COPY src ./src
COPY kb ./kb
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
CMD ["node", "src/main.mjs"]
