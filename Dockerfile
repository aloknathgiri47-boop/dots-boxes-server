FROM oven/bun:1
WORKDIR /app
ENV PORT=10000
COPY package.json ./
COPY index.ts ./
RUN bun install
EXPOSE 10000
CMD ["bun", "index.ts"]
