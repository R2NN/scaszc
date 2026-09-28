/** Represent a validated zero-distance leg at its known location without inventing a route. */
export function fillExactIdentityGeometry(plan, orders) {
  const points = new Map((orders || []).map(order => [String(order.id), order.coords]));
  return {
    ...plan,
    routes: (plan.routes || []).map(route => ({
      ...route,
      assignments: (route.assignments || []).map(visit => {
        if (Array.isArray(visit.geometry) && visit.geometry.length) return visit;
        const point = points.get(String(visit.orderId));
        if (Number(visit.distanceM || 0) !== 0 || !Array.isArray(point) || point.length !== 2) {
          throw new Error(`Нет проверенной геометрии переезда к заявке ${visit.orderId}.`);
        }
        return { ...visit, geometry: [point, point] };
      }),
    })),
  };
}
