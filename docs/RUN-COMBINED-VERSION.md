# Итоговая версия BeeGo: запуск и проверка

Ветка: [`codex/port-object-building-model`](https://github.com/R2NN/scaszc/tree/codex/port-object-building-model).

Включает текущие доработки карты, времени на объектах, рейтинга, справки, портретов и «Хода смены», а также итоговое состояние «Схемы объекта» из `43875ed`. Вся исходная ветка схемы не объединялась; перенесены файлы функции и точки подключения. Локальные SQLite-базы, резервные копии и секреты в Git не входят.

## Этот компьютер: продолжить с текущими данными

Репозиторий: `C:\Users\bio24\OneDrive\Desktop\ЛЦТ\bego-github`.

Сначала проверьте текущую ветку и состояние файлов. Не переключайте и не сбрасывайте рабочую копию с чужими незакоммиченными изменениями. Уже работающий BeeGo на 8787 можно использовать после проверки `/api/health`; второй процесс на тот же порт не запускайте. Для установки и обычного запуска из PowerShell:

```powershell
Set-Location 'C:\Users\bio24\OneDrive\Desktop\ЛЦТ\bego-github'
git fetch origin
git switch codex/port-object-building-model
git pull --ff-only
Set-Location site
pnpm install --frozen-lockfile
pnpm run build
pnpm run start:server
```

Открыть `http://127.0.0.1:8787/`. Этот запуск использует существующие `site/.beego-data/shifts.sqlite3` и `site/.dev.vars`; их не удаляйте и не заменяйте тестовой базой. При внешнем `BEEGO_DB_PATH` сохраняйте существующий путь. Для работы над интерфейсом вместо двух последних команд можно использовать `pnpm run dev -- --host 127.0.0.1 --port 8787 --strictPort`.

## Другой компьютер: чистая копия

Нужны Git, Node.js не ниже 22.13 и pnpm. В `site/package.json` закреплён pnpm 11.25.0; установка по lockfile проверяется отдельно. Не используйте `npm install` вместо зафиксированного pnpm-lockfile.

```powershell
git clone --branch codex/port-object-building-model --single-branch https://github.com/R2NN/scaszc.git BeeGo-combined
Set-Location BeeGo-combined/site
pnpm install --frozen-lockfile
pnpm run build
pnpm run start:server
```

Если pnpm отсутствует, установите закреплённую версию `npm install --global pnpm@11.25.0`. После запуска открыть `http://127.0.0.1:8787/`. Новая база создастся штатно с контрольной сменой; это не копия пользовательских опубликованных планов. Таблицы `building_models` и `building_model_history` создаются штатным API при обращении к схеме.

Для расчёта новых маршрутов дополнительно нужны Python >=3.12 с `algorithm/requirements-full.txt`, настроенная Valhalla и транспортные индексы. Для геокодирования и AI нужны собственные серверные ключи. История пользовательских смен, дорожные данные, конфигурация и расчётные артефакты переносятся отдельно по [правилам эксплуатации](operations.md) и [проверке готовности](PROJECT-READINESS.md). Пустой Git checkout не воспроизводит отсутствующий локальный архив. Квартиры и внутренние планы демонстрационного реестра явно синтетические; без явной привязки новой заявки расположение квартиры неизвестно.

## Проверка

Из `site/`:

```powershell
node --test --test-concurrency=4 tests/*.test.mjs
pnpm run test:algorithm
pnpm run build
```

Из корня при установленном Python-окружении:

```powershell
$env:PYTHONPATH=(Resolve-Path algorithm/src).Path
.venv/Scripts/python.exe -m pytest algorithm/tests -q
```

Итоговый прогон: 383 Node-теста прошли, 2 пропущены из-за отсутствия опционального полного архива; 239 Python-тестов прошли, 2 платных live-теста пропущены. Production-сборка успешна. 36 проверок схемы в Chrome/Playwright на обычном сервере и отдельной свежей базе, 19 скриншотов, 0 исключений JavaScript. Дополнительно проверены правки смены и экраны 390 px. Сохраняются предупреждение о размере bundle, служебные сообщения закрывающихся Vite SSR-тестовых серверов и deprecation-предупреждения SWIG; падений тестов нет.

Результаты: [checks.json](evidence/combined-version/checks.json), [галерея](evidence/combined-version/index.html), [браузерный отчёт](evidence/combined-version/building/browser-report.json). Ранее полученные материалы исходной ветки лежат отдельно в `docs/evidence/building-model/`.

## Готовый промпт для Codex

```text
Открой нашу итоговую версию BeeGo из https://github.com/R2NN/scaszc, ветка codex/port-object-building-model. На этом компьютере репозиторий находится в C:\Users\bio24\OneDrive\Desktop\ЛЦТ\bego-github. Прочитай docs/RUN-COMBINED-VERSION.md и site/AGENTS.md. Проверь ветку и рабочее дерево; сохрани текущие данные, .dev.vars, SQLite, историю и расчётные артефакты. При посторонних незакоммиченных изменениях используй отдельный checkout вместо сброса. Получи ветку из origin, установи зависимости site по pnpm-lock.yaml, собери и сам запусти обычный сервер. Если BeeGo уже работает на 8787, сначала проверь его и используй существующий процесс. Открой приложение в браузере, проверь /api/health, основные разделы, «Ход смены» и паспорт → «Схема объекта». Для тестов с записью используй отдельную базу. Покажи фактический URL и сообщи о недостающих внешних сервисах; не заменяй маршрутизацию заглушками и не выдумывай историю. Не пушь и не публикуй изменения без отдельной команды.
```
