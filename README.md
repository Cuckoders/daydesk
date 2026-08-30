# DayDesk

[![CI](https://github.com/Cuckoders/daydesk/actions/workflows/ci.yml/badge.svg)](https://github.com/Cuckoders/daydesk/actions/workflows/ci.yml)
![Tauri](https://img.shields.io/badge/Tauri-2-24c8db)
![React](https://img.shields.io/badge/React-19-61dafb)
![Platforms](https://img.shields.io/badge/platforms-Windows%20%7C%20macOS-6857eb)
![Rust tests](https://img.shields.io/badge/Rust_tests-23%2F23-success)

Нативное desktop-приложение для Windows и macOS: задачи, встречи, привычные перерывы, единая почта и виджеты рабочего стола. Основа — Tauri 2, React 19 и TypeScript.

> Native Windows and macOS productivity workspace with tasks, reminders, desktop widgets, a unified inbox, encrypted local mail cache, OAuth/IMAP integrations and secure email attachments.

## Уже работает

- обзор дня с задачами, событиями и письмами;
- добавление и завершение задач с локальным сохранением;
- создание, редактирование и удаление встреч, обеда, ужина, фокус-времени и личных событий;
- календарь с выбором дня, сортировкой расписания и настраиваемыми напоминаниями от 5 минут до 1 часа;
- системные уведомления о предстоящих событиях;
- отдельное компактное окно «План на сегодня» с режимом `alwaysOnBottom`;
- экраны задач, календаря, почты и галереи виджетов;
- реальное подключение Yandex, Mail.ru, iCloud и корпоративной почты по защищённому IMAP;
- Gmail через OAuth 2.0 и Gmail API, Outlook / Microsoft 365 через OAuth 2.0 и Microsoft Graph;
- единый список последних писем, ручное обновление, автоматическая синхронизация каждые пять минут и подключение нескольких аккаунтов;
- поиск по отправителю, теме и тексту превью во всех подключённых ящиках;
- безопасное чтение полного текста писем из Gmail, Outlook и IMAP прямо в DayDesk;
- просмотр списка вложений и безопасное скачивание файлов из Gmail, Outlook и IMAP;
- создание и отправка писем, ответы и исходящие вложения через Gmail API, Microsoft Graph или защищённый SMTP;
- локальный SQLite-кэш писем с шифрованием AES-256-GCM;
- хранение паролей и OAuth-токенов только в Keychain macOS или Credential Manager Windows.

## Запуск

```bash
npm install
npm run desktop:dev
```

Для быстрой проверки интерфейса в браузере:

```bash
npm run dev
```

Полная локальная проверка перед изменениями:

```bash
npm ci
npm audit --audit-level=moderate
npm run build
cd src-tauri
cargo fmt --check
cargo clippy --all-targets --all-features -- -D warnings
cargo test --all-targets -- --test-threads=1
```

## Сборка приложений

macOS (`DayDesk.app` и установочный образ `DayDesk.dmg`):

```bash
npm run build:mac
```

Универсальная сборка одновременно для Apple Silicon и Intel:

```bash
rustup target add aarch64-apple-darwin x86_64-apple-darwin
npm run build:mac:universal
```

Windows (`DayDesk-setup.exe` и `DayDesk.msi`):

```powershell
npm run build:windows
```

На Windows нужны Microsoft C++ Build Tools с workload «Desktop development with C++», WebView2 и Rust MSVC. MSI/NSIS лучше собирать непосредственно на Windows. Для публичного распространения обе сборки нужно подписать, а macOS DMG — также нотариализовать через Apple Developer.

Платформенные параметры разделены между `src-tauri/tauri.windows.conf.json` и `src-tauri/tauri.macos.conf.json`; Tauri автоматически применяет подходящий файл во время сборки.

Для сборки обеих платформ в GitHub предусмотрен ручной workflow `.github/workflows/desktop-builds.yml`. Он публикует универсальный macOS DMG и Windows x64 EXE/MSI как downloadable artifacts.

## Почтовая интеграция

Gmail и Outlook / Microsoft 365 подключаются через системный браузер по OAuth 2.0 с PKCE. DayDesk запрашивает отдельные минимальные разрешения на чтение и отправку почты, автоматически обновляет сессию и не получает пароль пользователя. После обновления со старой read-only версии OAuth-аккаунт нужно один раз переподключить. Перед сборкой нужно указать client ID провайдеров — подробности находятся в [инструкции по настройке OAuth](docs/OAUTH_SETUP.md).

Для Yandex, Mail.ru, iCloud и корпоративных провайдеров работает IMAP. В разделе «Почта» выберите провайдера или укажите адрес его IMAP- и SMTP-серверов. DayDesk читает почту только через TLS на порту 993, а отправляет через SMTPS 465 или обязательный STARTTLS 587. Если в почте включена двухфакторная защита, создайте отдельный пароль приложения в настройках провайдера.

Пароль существует во frontend только на время заполнения формы и не попадает в сохраняемое состояние, `localStorage` или логи. После успешной проверки он сохраняется Rust-сервисом в Keychain macOS либо Credential Manager Windows. При отключении аккаунта запись удаляется оттуда.

Отправитель, тема, превью и загруженное тело каждого письма сохраняются в локальной SQLite-базе только в зашифрованном виде. Для каждого поля создаётся отдельный случайный nonce, а ключ шифрования хранится в Keychain macOS либо Credential Manager Windows. Тексты писем не сохраняются в `localStorage`.

Поиск выполняется после расшифровки данных только в памяти Rust-процесса, поэтому открытый поисковый индекс с текстом писем на диске не создаётся.

Полный текст загружается только после открытия письма. MIME и HTML обрабатываются в Rust, после чего React получает обычный текст: скрипты, удалённые изображения и пиксели отслеживания из письма не запускаются. Размер ответа и отображаемого текста ограничен, а вложения не загружаются автоматически.

Вложения скачиваются по одному напрямую из Rust-процесса в системную папку «Загрузки», поэтому содержимое файла не передаётся в React/WebView и не сохраняется в почтовом кэше. DayDesk повторно проверяет идентификатор вложения, очищает имя от небезопасных символов, ограничивает размер файла 20 МБ и никогда не перезаписывает существующий файл — для совпадающего имени создаётся новый вариант с номером. Метаданные вложений в SQLite-кэше шифруются вместе с остальными данными письма.

Исходящий редактор создаёт только обычный текст и не сохраняет черновик после закрытия. Перед реальной отправкой показывается отдельный экран подтверждения с отправителем, получателями, темой и числом файлов. Выбранные файлы читаются Rust-процессом в ограниченную временную память и выдаются frontend только как одноразовые идентификаторы. В этой версии можно прикрепить до 10 файлов суммарно не больше 2 МБ; это позволяет одинаково безопасно работать с прямой отправкой Microsoft Graph, Gmail API и SMTP.
