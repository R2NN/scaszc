# Стенд BeeGo на Yandex Compute Cloud

Стенд запускает один экземпляр `site/server/main.mjs` за Nginx. Поэтому все запросы к точному планировщику и предпросмотру перепланирования делят один слот; второй запуск получает HTTP 429 с кодом `PLANNING_BUSY`. Просмотр сайта и чтение API продолжают работать.

- Код текущего релиза: `/opt/beego/current` → `/opt/beego/releases/<commit>`.
- Рабочая база SQLite: `/srv/beego-data/shifts.sqlite3`, вне релизного каталога.
- Старые дорожные данные, Python-окружение и Valhalla оставлены в `/srv/beego` до их плановой миграции.
- Конфигурация API: `/etc/beego/api.env`, доступ только root.
- Сервисы: `beego-api.service`, `nginx`, Docker-контейнер `beego-valhalla`.

После установки зависимостей (`pnpm install --frozen-lockfile`) и сборки (`pnpm run build`) разместите unit и Nginx-конфигурацию из этого каталога, проверьте `nginx -t`, затем перезапустите сервисы. Проверки: `pnpm run test:algorithm`, `pnpm run test:sites`, `node --test tests/planning-slot.test.mjs tests/shift-operations.test.mjs`, `curl http://127.0.0.1:8787/api/health`.

Публичный IP динамический. При смене IP обновите `server_name` и ссылку на стенд. Для реальных данных настройте домен и HTTPS перед использованием.
