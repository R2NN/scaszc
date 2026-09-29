/** Choose a notification title from its event, without treating equipment names as event types. */
export function notificationPresentation(item) {
  const suppliedTitle = (item?.title || '').trim();
  const text = `${suppliedTitle} ${item?.message || ''}`.toLocaleLowerCase('ru-RU');
  if (/ошиб|не выполн|не удалось|недоступ/.test(text)) {
    return { kind: 'alert', title: suppliedTitle && suppliedTitle !== 'BeeGo!' ? suppliedTitle : 'Требуется внимание' };
  }
  if (/участ|регион|адресам файла/.test(text)) return { kind: 'location', title: 'Рабочий участок определён' };
  if (/импорт|загруж|файл|геокод/.test(text)) {
    return { kind: 'import', title: /ошиб|не найден/.test(text) ? 'Проверьте адреса' : 'Данные успешно загружены' };
  }
  if (/настройки планирования/.test(text)) return { kind: 'system', title: 'Планирование сохранено' };
  if (/настройки ограничений/.test(text)) return { kind: 'system', title: 'Ограничения сохранены' };
  if (/переплан/.test(text)) return { kind: 'route', title: 'Маршруты перестроены' };
  if (/план|маршрут|распредел/.test(text)) return { kind: 'route', title: 'Маршруты построены' };
  if (/назначен|инженер|команд/.test(text)) {
    return { kind: 'assignment', title: /сохран/.test(text) ? 'Назначение сохранено' : 'Команда обновлена' };
  }
  if (/профил|настрой/.test(text)) return { kind: 'profile', title: 'Профиль обновлён' };
  return { kind: 'system', title: suppliedTitle && suppliedTitle !== 'BeeGo!' ? suppliedTitle : 'Системное событие' };
}
