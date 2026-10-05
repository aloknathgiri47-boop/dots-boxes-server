FROM oven/bun:1
WORKDIR /app
COPY package.json ./
COPY index.ts ./
RUN bun install
EXPOSE 3003
CMD ["bun", "run", "index.ts"]
