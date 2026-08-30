# Настройка OAuth для Gmail и Outlook

DayDesk использует Authorization Code Flow с PKCE, системный браузер и локальный callback. Client secret в desktop-приложении не используется. OAuth client ID не является секретом и встраивается в приложение во время сборки.

## Google / Gmail

1. Создайте проект в [Google Cloud Console](https://console.cloud.google.com/).
2. Включите [Gmail API](https://console.cloud.google.com/apis/library/gmail.googleapis.com) и [Google Calendar API](https://console.cloud.google.com/apis/library/calendar-json.googleapis.com).
3. Настройте OAuth consent screen. Пока приложение находится в режиме тестирования, добавьте нужные адреса в список test users.
4. Создайте OAuth Client ID типа **Desktop app**.
5. Скопируйте client ID в переменную `DAYDESK_GOOGLE_CLIENT_ID`.

DayDesk запрашивает `https://www.googleapis.com/auth/gmail.readonly` для чтения почты, `https://www.googleapis.com/auth/gmail.send` для отправки и `https://www.googleapis.com/auth/calendar.events` для чтения и изменения событий. Доступ к настройкам календаря, контактам, изменению или удалению писем не запрашивается.

## Microsoft / Outlook и Microsoft 365

1. Создайте App registration в [Microsoft Entra admin center](https://entra.microsoft.com/).
2. Выберите поддерживаемые типы аккаунтов. Для Outlook.com и рабочих Microsoft 365 аккаунтов нужен вариант, разрешающий personal и organizational accounts.
3. В Authentication добавьте платформу **Mobile and desktop applications** и redirect URI `http://localhost/oauth/callback`.
4. Разрешите public client flow. Client secret создавать не нужно.
5. Добавьте delegated permissions Microsoft Graph: `User.Read`, `Mail.Read`, `Mail.Send` и `Calendars.ReadWrite`.
6. Скопируйте Application (client) ID в `DAYDESK_MICROSOFT_CLIENT_ID`.

При loopback redirect Microsoft игнорирует номер порта для `localhost`, поэтому DayDesk выбирает свободный локальный порт при каждом входе.

Если аккаунт подключался к предыдущей сборке DayDesk, отключите и подключите его снова. Старый refresh token не содержит разрешения на календарь.

## Синхронизация календаря

После подключения OAuth-аккаунта DayDesk может синхронизировать основной календарь Google или календарь по умолчанию Microsoft. В разделе «Календарь» интеграцию можно отдельно включить, выключить или обновить вручную. Включённые календари автоматически обновляются каждые 10 минут.

DayDesk загружает события за последние 30 и следующие 365 дней. Обычные встречи можно создавать, изменять и удалять с обеих сторон. События на весь день импортируются для просмотра и остаются доступными для редактирования в исходном календаре.

## Локальная сборка

macOS:

```bash
export DAYDESK_GOOGLE_CLIENT_ID="google-client-id.apps.googleusercontent.com"
export DAYDESK_MICROSOFT_CLIENT_ID="00000000-0000-0000-0000-000000000000"
npm run build:mac:universal
```

Windows PowerShell:

```powershell
$env:DAYDESK_GOOGLE_CLIENT_ID = "google-client-id.apps.googleusercontent.com"
$env:DAYDESK_MICROSOFT_CLIENT_ID = "00000000-0000-0000-0000-000000000000"
npm run build:windows
```

Для GitHub Actions создайте repository variables с именами `DAYDESK_GOOGLE_CLIENT_ID` и `DAYDESK_MICROSOFT_CLIENT_ID`. Workflow уже передаёт их обеим desktop-сборкам.

## Хранение данных

- только refresh token хранится в Keychain macOS или Credential Manager Windows;
- короткоживущий access token получается заново при синхронизации и остаётся только в памяти процесса;
- токены не передаются в React, `localStorage` или логи;
- в локальном состоянии интерфейса остаются только адрес аккаунта, название провайдера, данные списка писем и копия синхронизированных событий;
- при отключении аккаунта локальная запись токена удаляется.

Официальные протоколы: [Google OAuth для desktop apps](https://developers.google.com/identity/protocols/oauth2/native-app) и [Microsoft authorization code flow](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow).
