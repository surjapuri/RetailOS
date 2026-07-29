FROM node:20-alpine AS base
WORKDIR /app
RUN apk add --no-cache curl
COPY package*.json ./
RUN npm ci --only=production && npm cache clean --force

FROM base AS production
COPY src/ ./src/
RUN mkdir -p logs
RUN addgroup -g 1001 -S nodejs && adduser -S nodeapp -u 1001
RUN chown -R nodeapp:nodejs /app
USER nodeapp
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
  CMD curl -f http://localhost:4000/health || exit 1
CMD ["node", "src/app.js"]
