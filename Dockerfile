FROM oven/bun:1
WORKDIR /app
ENV PORT=10000
COPY package.json ./
COPY index.ts ./
COPY engine.ts ./
COPY game-types.ts ./
RUN bun install
EXPOSE 10000
CMD ["bun", "index.ts"]
