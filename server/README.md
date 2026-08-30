# DayDesk Sync Server

Локальный sync-сервис для обмена задачами между DayDesk Desktop и DayDesk Mobile.

## Запуск

```bash
cd server
npm install
cp .env.example .env
```

Задайте в `.env` случайный setup-код длиной не меньше 12 символов. Для почтового коннектора также создайте отдельный 32-байтовый ключ:

```bash
openssl rand -base64 32 | tr '+/' '-_' | tr -d '='
# вставьте результат в DAYDESK_MAIL_KEY и запустите
npm run dev
```

Храните резервную копию `DAYDESK_MAIL_KEY` отдельно от базы. После его потери сохранённые пароли почты нельзя расшифровать — аккаунты потребуется подключить заново.

Для OAuth-подключения Gmail и Outlook из мобильного приложения задайте публичный HTTPS origin сервера и credentials провайдеров:

```dotenv
DAYDESK_OAUTH_PUBLIC_URL=https://sync.example.com
DAYDESK_GOOGLE_CLIENT_ID=...
DAYDESK_GOOGLE_CLIENT_SECRET=...
DAYDESK_MICROSOFT_CLIENT_ID=...
DAYDESK_MICROSOFT_CLIENT_SECRET=...
```

Зарегистрируйте точные web redirect URI:

- `https://sync.example.com/v1/mail/oauth/callback/gmail` в Google Cloud;
- `https://sync.example.com/v1/mail/oauth/callback/outlook` в Microsoft Entra.

Mobile-client не получает client secret или почтовые токены: Authorization Code Flow с PKCE завершается на sync-сервере. Для локальной разработки HTTP разрешён только на `localhost`, `127.0.0.1` и `::1`.

По умолчанию сервер слушает только `127.0.0.1:4310`. Для телефона в локальной сети укажите IP интерфейса через `DAYDESK_HOST` и используйте HTTPS reverse proxy перед любым доступом из интернета.

## Протокол

- `POST /v1/devices/register` — однократная регистрация по setup-коду;
- `POST /v1/sync` — push/pull батч до 500 изменений задач, локальных событий и ритуалов;
- `GET /v1/mail/accounts` — список подключённых почтовых аккаунтов без секретов;
- `GET /v1/mail/oauth/providers` — доступные OAuth-провайдеры;
- `POST /v1/mail/oauth/start` и `GET /v1/mail/oauth/status/:flowId` — запуск и привязанная к устройству проверка входа;
- `GET /v1/mail/oauth/callback/:provider` — одноразовое завершение OAuth-кода на сервере;
- `POST /v1/mail/accounts/imap` — проверка TLS-подключения и сохранение зашифрованного пароля приложения;
- `POST /v1/mail/sync` — получение последних писем из `inbox` или `sent` каждого аккаунта;
- `GET /v1/mail/messages/:accountId/:messageId` — безопасное получение текста и метаданных вложений;
- `GET /v1/mail/messages/:accountId/:messageId/attachments/:attachmentId` — загрузка одного входящего вложения до 2 МБ;
- `GET /v1/mail/messages/:accountId/:messageId/attachments/:attachmentId/invitation` — безопасный разбор одиночного `.ics` до 256 КБ без сохранения исходного файла;
- `POST/DELETE /v1/mail/attachments` — временная загрузка и удаление исходящих вложений;
- `POST /v1/mail/send` — отправка подтверждённого письма через Gmail API, Microsoft Graph или SMTP;
- `DELETE /v1/mail/accounts/:accountId` — удаление аккаунта и его зашифрованного секрета;
- `DELETE /v1/devices/current` — отзыв токена текущего устройства;
- `GET /health` — проверка готовности.

Device-token возвращается один раз. В SQLite сохраняется только его SHA-256 хеш. Все сущности разрешают конфликты по `updatedAt`, при равном времени — детерминированно по ID устройства. Удаления сохраняются как tombstones.

IMAP работает только через TLS на порту 993. Пароль шифруется AES-256-GCM с уникальным nonce и привязкой к ID аккаунта. По умолчанию сервер отклоняет loopback, link-local, private и зарезервированные адреса после DNS-разрешения; корпоративные IMAP-серверы в LAN разрешаются только явным `DAYDESK_ALLOW_PRIVATE_MAIL_HOSTS=true`.

OAuth использует PKCE S256 и случайный `state`; в базе хранится только SHA-256 `state`, а verifier очищается после callback. Access/refresh-токены шифруются тем же `DAYDESK_MAIL_KEY`, статус входа доступен только начавшему его устройству. Запрашиваются Gmail `gmail.readonly` и `gmail.send`, Microsoft `User.Read`, `Mail.Read`, `Mail.Send` и `offline_access`. Аккаунт, подключённый до появления отправки, нужно один раз переподключить.

Исходящие вложения хранятся только в оперативной памяти: до 10 файлов общим размером не больше 2 МБ, с TTL 15 минут и привязкой к device-token. После успешной отправки одноразовые токены и байты очищаются. IMAP-аккаунты отправляют через SMTPS 465 или обязательный STARTTLS 587; SMTP-адрес повторно проходит DNS/SSRF-проверку. Тела входящих писем и вложения не кэшируются сервером: файлы до 2 МБ выдаются только по отдельному авторизованному запросу, а использованный буфер очищается после ответа. Импорт календаря принимает только `text/calendar` или `.ics` до 256 КБ, отклоняет отменённые, повторяющиеся, многособытийные и неоднозначные по часовому поясу приглашения и возвращает лишь очищенные поля встречи.

## Проверка

```bash
npm run typecheck
npm test
npm run build
```

Сервис основан на общих паттернах Fastify/Node.js из `sickn33/antigravity-awesome-skills`, source commit `9bad53f2426e310c33ef5bacf9f845855197be6a` (MIT), адаптированных под персональный offline-first DayDesk.
