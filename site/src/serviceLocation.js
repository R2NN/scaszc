const addressWords = new Set(['г', 'город', 'ул', 'улица', 'д', 'дом']);

/** Compare address formatting while retaining city, street, house and building identifiers. */
export function addressIdentity(address) {
  return String(address || '').normalize('NFKC').toLocaleLowerCase('ru-RU').replaceAll('ё', 'е')
    .replace(/\b(?:pr-?kt)\b/g, 'проспект').replace(/пр(?:-|\s)*кт|пр-т/g, 'проспект').replace(/пр-зд/g, 'проезд').replace(/б-р/g, 'бульвар')
    .replace(/(\d)([а-я])(?=\s|$)/g, '$1 $2').replace(/(\d)(к|корп|стр)(?=\d)/g, '$1 $2 ').replace(/([^\d])([0-9]+)/g, '$1 $2')
    .replace(/[^а-яa-z0-9/]+/g, ' ').trim().split(/\s+/)
    .filter(word => word && !addressWords.has(word))
    .map(word => ({ к: 'корпус', корп: 'корпус', стр: 'строение', пркт: 'проспект', 'пр-т': 'проспект' })[word] || word).join(' ');
}

/** Moving the service point requires a new explicit object/infrastructure association. */
export function changeServiceLocation(form, location) {
  return { ...form, ...location, objectId: undefined, serviceEntities: undefined, durationSnapshot: undefined };
}

/** Reject a registered object paired with a different house or geographic point. */
export function assertServiceLocation(order, object) {
  if (order.address && object.address && addressIdentity(order.address) !== addressIdentity(object.address)) throw new Error('Адрес заявки не совпадает с выбранным объектом. Выберите объект для нового адреса.');
  if (Array.isArray(order.coords) && Array.isArray(object.coords)) {
    const radians = Math.PI / 180;
    const latitude = (order.coords[0] + object.coords[0]) * radians / 2;
    const distance = 6371000 * Math.hypot((order.coords[0] - object.coords[0]) * radians, (order.coords[1] - object.coords[1]) * radians * Math.cos(latitude));
    if (!Number.isFinite(distance) || distance > 75) throw new Error('Точка заявки не совпадает с выбранным объектом. Подтвердите объект для этой точки.');
  }
}
