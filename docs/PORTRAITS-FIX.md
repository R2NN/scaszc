# Исправление кадрирования портретов

Причина: исходные `portrait-26.jpg`–`portrait-33.jpg` содержали фрагменты соседних ячеек фотолиста, белые разделители и чёрные области. Обычный `object-fit: cover` показывал эти дефекты внутри круглых аватаров.

Общий `site/src/EngineerPortrait.jsx` теперь применяется в заявках/маршрутах, ходе смены, рейтинге, предложении состава, очереди обращений и аналитике. Шесть портретов показываются через точные области сохранённых фрагментов. ID и уникальность назначений сохранены. Исходные JPEG не переписывались.

Два неполных лица восстановлены встроенным imagegen с сохранением личности по двум сохранившимся фрагментам. Новые файлы:

- `site/public/engineer-portraits/portrait-29-restored.png`
- `site/public/engineer-portraits/portrait-33-restored.png`

Запрос для первого восстановления:

> Edit target: restore ONE square avatar photograph of the older man with short gray hair and a gray mustache outdoors, whose left face portion is on the right edge of input 1 and right face portion is on the left edge of input 2. These are mis-cut overlapping photo-sheet fragments. Reconstruct his COMPLETE centered head and shoulders, remove all sheet divider lines and black empty padding, and preserve his exact recognizable face, mustache, age, navy work jacket and natural outdoor street background. Do not include the bearded man with glasses from the left of input 1. Output ONE clean seamless square photographic portrait, centered eyes, full forehead and chin, no collage, no text or border. Match existing neutral candid technician headshots. Identity-preserve correction only.

Входы: `portrait-28.jpg`, `portrait-29.jpg`.

Запрос для второго восстановления:

> Edit target: restore ONE square avatar photograph of the middle-aged man with short light-brown hair, glasses, clean-shaven face and navy work jacket in the bright indoor technical workplace. His left face portion is on the right edge of input 1 and right face portion is on the left edge of input 2. These are mis-cut overlapping photo-sheet fragments. Reconstruct his COMPLETE centered head and shoulders, remove all sheet divider lines and black empty padding, and preserve his exact recognizable face, glasses, age, navy jacket and original bright office background with blue accent. Do not include the young curly-haired man from the left of input 1. Output ONE clean seamless square photographic portrait, centered eyes, full forehead and chin, no collage, no text or border. Identity-preserve correction only.

Входы: `portrait-32.jpg`, `portrait-33.jpg`.

Проверено: все 33 исходных файла просмотрены; восемь исправленных портретов отрендерены из настоящего React-компонента и визуально просмотрены в [превью](evidence/portrait-fix/renderer-preview.png). Все 347 Node-тестов прошли; после подключения восстановленных файлов повторена проверка уникальности привязки и наличия файлов. Итоговая сборка прошла. Браузерная проверка в этом запуске недоступна: инструмент сообщает об отключённом доступе, хотя пользователь подтверждает включённый переключатель. Превью является рендером компонента, не скриншотом страницы.

Расчёт, данные смен и сервер не менялись. Новых production-зависимостей нет.
