# Возврат к сохранённой версии BeeGo! перед заданием № 3

Код: `ba829e8d1b90508fefd85bc075ebabaae280ec29`.

- GitHub: `https://github.com/R2NN/scaszc/tree/safety/pre-tz3-20261017`.
- Тег: `beego-before-tz3-20261017`.
- Автономная копия: `A:/BeeGo-final-handoff/pre-tz3-20261017/beego-before-tz3.bundle`.
- БД: `A:/BeeGo-final-handoff/pre-tz3-20261017/candidate-release.sqlite3`.
- Проверки и SHA-256: `A:/BeeGo-final-handoff/pre-tz3-20261017/manifest.json`.

Тег и safety-ветка опубликованы. Они являются точками возврата; не перемещать и не использовать для дальнейшей работы. Сохранённый кандидат продолжает работать на `http://127.0.0.1:4199/`. Задание № 3 должно работать отдельно, например на 4200.

## Вернуть рабочую версию без удаления новой работы

Команды выполняет агент, если пользователь просит восстановить. Сначала проверь занятость путей и портов, при необходимости выбери новые имена. Новые ветки и БД не удаляй.

```powershell
# Из существующего репозитория
git fetch origin --tags
git rev-parse 'beego-before-tz3-20261017^{commit}'
# Ожидается ba829e8d1b90508fefd85bc075ebabaae280ec29
git worktree add -b restore/beego-before-tz3 A:/BeeGo-restored-before-tz3 beego-before-tz3-20261017

# Используй отдельную рабочую копию сохранённой БД; резерв не открывать на запись
New-Item -ItemType Directory -Path A:/BeeGo-restored-before-tz3/runtime/restore -Force
Copy-Item -LiteralPath A:/BeeGo-final-handoff/pre-tz3-20261017/candidate-release.sqlite3 -Destination A:/BeeGo-restored-before-tz3/runtime/restore/shifts.sqlite3
```

Без GitHub можно восстановить полный код из bundle:

```powershell
git bundle verify A:/BeeGo-final-handoff/pre-tz3-20261017/beego-before-tz3.bundle
git clone --branch safety/pre-tz3-20261017 A:/BeeGo-final-handoff/pre-tz3-20261017/beego-before-tz3.bundle A:/BeeGo-restored-from-bundle
```

Далее из нового checkout/site установи зависимости по существующему lockfile (`pnpm install --frozen-lockfile`, если подходит фактическому формату lockfile), собери `pnpm build`, запусти сервер на отдельном свободном порту:

```powershell
$env:BEEGO_DB_PATH='A:/BeeGo-restored-before-tz3/runtime/restore/shifts.sqlite3'
$env:BEEGO_PYTHON='A:/BeeGo-final-object-complexity/.venv/Scripts/python.exe'
$env:VALHALLA_ROUTE_ENDPOINT='http://127.0.0.1:8002/route'
$env:PORT='4201'
node server/main.mjs
```

Пути окружения и доступность маршрутизатора проверь на конкретной машине. Bundle содержит Git-историю, но не node_modules, Python venv, гигабайтные дорожные данные и локальные секреты. Они восстанавливаются/подключаются отдельно штатными средствами. БД восстанови до запуска сервера, чтобы он не создал другое состояние через seed.

Сверь SHA-256 резервной БД с манифестом, SQLite integrity, покрытие 203/205, аварии 15/15, 34 инженера, паспорта и комментарии. Это восстановление сохранённого плана, не новый поиск. Сама новая работа агента остаётся в его ветке и отдельной БД.

Для возвращения прежнего адреса после проверки достаточно переключить явно нужный кандидатный процесс на проверенную восстановленную копию. Не меняй main и не делай force-push. Не копируй сохранённую БД поверх работающей WAL-БД и не рассчитывай, что `git reset` откатывает данные.
