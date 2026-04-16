FROM node:20-slim

# Instala OpenSSL (lo que Prisma necesita)
RUN apt-get update -y && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
COPY prisma ./prisma

RUN npm install --omit=dev
RUN npx prisma generate

COPY . .

EXPOSE 3000
CMD ["sh", "-c", "npx prisma migrate deploy && node server.js"]
