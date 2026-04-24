FROM node:20-alpine

WORKDIR /app

RUN apk add --no-cache \
    sqlite \
    python3 \
    make \
    g++

COPY package*.json ./

RUN npm ci --only=production && npm cache clean --force

COPY . .

RUN mkdir -p uploads

RUN addgroup -g 1001 -S nodejs && \
    adduser -S whatsapp-agent -u 1001

RUN chown -R whatsapp-agent:nodejs /app

USER whatsapp-agent

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/health', (res) => { process.exit(res.statusCode === 200 ? 0 : 1) })"

CMD ["npm", "start"]
