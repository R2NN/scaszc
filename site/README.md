# BeeGo!

Прототип диспетчерского интерфейса для импорта заявок и инженеров, построения точных маршрутов и событийного перепланирования.

## Локальный запуск

Требуется Node.js 20+.

```powershell
npm install
npm run dev:api
```

Во втором терминале:

```powershell
npm run dev -- --host 127.0.0.1 --port 4174
```

Откройте `http://127.0.0.1:4174/`.

## Проверочный сценарий

1. Загрузите `public/test-data/beego-algorithm-initial.json`.
2. В окне проверки нажмите «Загрузить 205 заявок и 35 инженеров».
3. Нажмите «Спланировать» → «Построить план»: интерфейс покажет 200 назначений и 5 неназначенных заявок.
4. Нажмите «Новая авария»: будет добавлена `EAST-EVENT-001`, после проверки событийного плана станет 201 назначение и 5 неназначенных заявок.

Сразу проверить готовый событийный набор можно файлом `public/test-data/beego-algorithm-integration.json`.

## Проверки

```powershell
npm run test:algorithm
npm run test:sites
npm run build
```

Архитектура, контрольные суммы, ограничения и результаты проверки описаны в [docs/algorithm-integration.md](docs/algorithm-integration.md). Требования задачи зафиксированы в [docs/task-requirements.md](docs/task-requirements.md).

## Внешние компоненты

- OR-Tools CP-SAT — точное распределение и порядок визитов;
- Valhalla — дорожные времена, расстояния и геометрии;
- Geoapify — геокодирование адресов через backend-прокси;
- MapLibre GL и OpenFreeMap/OpenStreetMap — отображение карты.

API публикует только планы со статусами `EXACT_VALID`, `publication_allowed=true` и `validation.status=VALID`. Для произвольно изменённого набора требуется полный серверный перерасчёт с Valhalla; Worker намеренно не создаёт приблизительные маршруты.
