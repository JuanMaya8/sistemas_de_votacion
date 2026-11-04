FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm install --omit=dev && npm cache clean --force
COPY src ./src
COPY scripts ./scripts
EXPOSE 3000
USER node
CMD ["node", "src/index.js"]
