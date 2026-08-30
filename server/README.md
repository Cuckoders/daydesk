# DayDesk Sync Server

Локальный sync-сервис для обмена задачами между DayDesk Mobile и будущим desktop-клиентом.

## Запуск

```bash
cd server
npm install
cp .env.example .env
```

Задайте в окружении случайный setup-код длиной не меньше 12 символов, затем:

```bash
DAYDESK_SETUP_CODE='your-private-setup-code' npm run dev
```

По умолчанию сервер слушает только `127.0.0.1:4310`. Для телефона в локальной сети укажите IP интерфейса через `DAYDESK_HOST` и используйте HTTPS reverse proxy перед любым доступом из интернета.

## Протокол

- `POST /v1/devices/register` — однократная регистрация по setup-коду;
- `POST /v1/sync` — push/pull батч до 500 изменений;
- `DELETE /v1/devices/current` — отзыв токена текущего устройства;
- `GET /health` — проверка готовности.

Device-token возвращается один раз. В SQLite сохраняется только его SHA-256 хеш. Задачи разрешают конфликты по `updatedAt`, при равном времени — детерминированно по ID устройства. Удаления сохраняются как tombstones.

## Проверка

```bash
npm run typecheck
npm test
npm run build
```

Сервис основан на общих паттернах Fastify/Node.js из `sickn33/antigravity-awesome-skills`, source commit `9bad53f2426e310c33ef5bacf9f845855197be6a` (MIT), адаптированных под персональный offline-first DayDesk.
