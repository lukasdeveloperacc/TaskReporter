FROM node:24-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev
RUN mkdir -p /data && chown node:node /data
USER node
ENV HOST=0.0.0.0 PORT=4780 DB_PATH=/data/office.db
EXPOSE 4780
CMD ["node", "server/main.ts"]
