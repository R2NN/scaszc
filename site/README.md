# Сайт BeeGo!

React-интерфейс и Node API для диспетчера. Общая архитектура, результаты проверки и порядок сдачи описаны в [README проекта](../README.md).

Из каталога `site` установите зафиксированные зависимости: `pnpm install --frozen-lockfile`. В одном терминале запустите `pnpm run dev:api`, во втором — `pnpm run dev -- --host 127.0.0.1 --port 5173`. Откройте `http://127.0.0.1:5173/`. API доступен на `http://127.0.0.1:8787/api/health`; порт можно изменить через `BEEGO_API_PORT`.

Проверки: `pnpm run build`, `pnpm run test:sites`, `pnpm run test:algorithm`, `pnpm run test:analytics-history` и `pnpm exec node --test tests/planning-slot.test.mjs`.

Готовые планы работают без Python. Новый точный расчёт требует Python, Valhalla и офлайн-данных; см. [инструкцию стенда](../deploy/README_RU.md). Ключ Geoapify нужен только для геокодирования новых адресов: пример находится в `.dev.vars.example`, рабочий `.dev.vars` не коммитится.
