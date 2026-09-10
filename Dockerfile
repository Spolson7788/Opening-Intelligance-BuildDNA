FROM node:20-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:20-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
COPY --from=build /app/migrations ./migrations
COPY --from=build /app/scripts ./scripts

EXPOSE 3000
# Run pending migrations, then start the server. Safe to run on every deploy —
# the migration runner tracks what's already applied and skips it.
CMD ["sh", "-c", "npm run migrate && npm start"]
