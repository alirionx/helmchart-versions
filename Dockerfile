FROM node:26-alpine

ENV NODE_ENV=production \
    PORT=3000 \
    SOURCES_FILE=/data/sources.json

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY server.js ./
COPY public ./public

# The chart list is written to /data, so it survives container restarts when /data is a volume
RUN mkdir /data && chown node:node /data
VOLUME /data

USER node
EXPOSE 3000

CMD ["node", "server.js"]
