# Образ платформы. Что он покрывает и чего нет — в DEPLOYMENT.md, раздел «Docker-вариант».
FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
# По умолчанию сервер слушает 127.0.0.1 (server/config.js, BIND_HOST) — за cloudflared
# другого и не нужно. В контейнере порт снаружи иначе не виден.
ENV BIND_HOST=0.0.0.0
# Список людей — рядом с данными, чтобы пережить пересоздание контейнера (том /app/data).
ENV USERS_FILE=/app/data/users.json
# poppler — текстовый слой и рендер страниц PDF (doc-vision, нормоконтроль, ГГЭ);
# LibreDWG — DWG → DXF в разборе чертежей и запасной путь DXF → DWG без AutoCAD.
RUN apt-get update \
  && apt-get install -y --no-install-recommends poppler-utils libredwg-tools \
  && rm -rf /var/lib/apt/lists/*
# Имена явно, не package*.json: маска захватывает iCloud-дубликаты вида «package 2.json».
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY server ./server
COPY prompts ./prompts
COPY public ./public
COPY scripts ./scripts
# Базы модулей: нормоконтроль (rules/, knowledge/, templates/ — NORMO_KB_DIR)
# и библиотека промптов (services/doclib.js читает её из корня проекта).
COPY ["нормоконтроль", "./нормоконтроль"]
COPY ["библиотека-промптов", "./библиотека-промптов"]
RUN mkdir -p /app/data && chown -R node:node /app
USER node
EXPOSE 3000
CMD ["node", "server/index.js"]
