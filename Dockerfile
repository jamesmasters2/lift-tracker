FROM node:20-alpine

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY server.js ./
COPY public ./public

# Data written here is meant to be a mounted host volume (see
# docker-compose.yml) so it survives container rebuilds/restarts.
VOLUME ["/app/data"]
ENV DATA_DIR=/app/data
ENV PORT=3000

EXPOSE 3000

CMD ["node", "server.js"]
