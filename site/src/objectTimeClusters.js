const countFormat = new Intl.NumberFormat('ru-RU');

/** Describe only aggregate values supplied by the map source. */
export function objectClusterSummary(properties) {
  const count = value => value !== undefined && value !== null && value !== '' && Number.isSafeInteger(Number(value)) && Number(value) >= 0 ? Number(value) : null;
  const total = count(properties.point_count);
  const increased = count(properties.slower);
  const unknown = count(properties.unknown);
  const rows = [{ label: 'Объектов', value: total }, { label: 'С увеличенным временем', value: increased }, { label: 'Недостаточно сведений', value: unknown }].filter(row => row.value !== null);
  return {
    total,
    label: total === null ? '—' : countFormat.format(total),
    indicator: increased > 0 ? `↑ ${countFormat.format(increased)}` : '',
    rows,
    description: rows.map(row => `${row.label}: ${countFormat.format(row.value)}`).join('. '),
  };
}

/** Keep accessible HTML group chips on the existing map, including style reloads. */
export function mountObjectTimeClusters(map, Marker, onExpand, onError) {
  const markers = new Map();
  const container = map.getContainer();
  let disposed = false;
  const remove = entry => { entry.marker.remove(); entry.tooltip.remove(); };
  const create = feature => {
    const summary = objectClusterSummary(feature.properties);
    const root = document.createElement('div');
    root.className = 'cx-cluster-marker';
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'cx-cluster-chip';
    button.setAttribute('aria-label', `Раскрыть группу. ${summary.description}`);
    const total = document.createElement('span');
    total.className = 'cx-cluster-count';
    total.textContent = summary.label;
    button.append(total);
    if (summary.indicator) {
      const indicator = document.createElement('span');
      indicator.className = 'cx-cluster-increased';
      indicator.textContent = summary.indicator;
      indicator.setAttribute('aria-hidden', 'true');
      button.append(indicator);
    }
    const tooltip = document.createElement('div');
    tooltip.className = 'cx-cluster-tooltip';
    tooltip.id = `cx-cluster-tip-${feature.properties.cluster_id}`;
    tooltip.setAttribute('role', 'tooltip');
    tooltip.hidden = true;
    for (const row of summary.rows) {
      const line = document.createElement('div');
      const label = document.createElement('span');
      const value = document.createElement('b');
      label.textContent = row.label;
      value.textContent = countFormat.format(row.value);
      line.append(label, value);
      tooltip.append(line);
    }
    container.append(tooltip);
    button.setAttribute('aria-describedby', tooltip.id);
    let hovered = false;
    let focused = false;
    let expanding = false;
    const hide = () => { tooltip.hidden = true; };
    const show = () => {
      if (!hovered && !focused) { hide(); return; }
      tooltip.hidden = false;
      const box = button.getBoundingClientRect();
      const mapBox = container.getBoundingClientRect();
      const scaleX = mapBox.width / container.clientWidth;
      const scaleY = mapBox.height / container.clientHeight;
      const panel = container.closest('.workspace-grid')?.querySelector('.cx-time-panel');
      const panelBox = panel?.getBoundingClientRect();
      const leftEdge = panelBox && box.left >= panelBox.right ? (panelBox.right - mapBox.left) / scaleX + 8 : 8;
      const width = tooltip.offsetWidth;
      const height = tooltip.offsetHeight;
      const left = Math.max(leftEdge, Math.min((box.left - mapBox.left + box.width / 2) / scaleX - width / 2, container.clientWidth - width - 80));
      const above = (box.top - mapBox.top) / scaleY - height - 9;
      tooltip.style.left = `${left}px`;
      tooltip.style.top = `${above >= 64 ? above : Math.min((box.bottom - mapBox.top) / scaleY + 9, container.clientHeight - height - 8)}px`;
    };
    button.addEventListener('mouseenter', () => { hovered = true; show(); });
    button.addEventListener('mouseleave', () => { hovered = false; show(); });
    button.addEventListener('focus', () => { focused = true; show(); });
    button.addEventListener('blur', () => { focused = false; show(); });
    button.addEventListener('keydown', event => { if (event.key === 'Escape') hide(); });
    button.addEventListener('click', async event => {
      event.stopPropagation();
      if (expanding || disposed) return;
      expanding = true;
      hide();
      try {
        const source = map.getSource('cx-objects');
        const id = Number(feature.properties.cluster_id);
        const [leaves, zoom] = await Promise.all([source.getClusterLeaves(id, summary.total, 0), source.getClusterExpansionZoom(id)]);
        if (disposed || source !== map.getSource('cx-objects')) return;
        onExpand(leaves.map(leaf => leaf.properties.id));
        const mapBox = container.getBoundingClientRect();
        const panel = container.closest('.workspace-grid')?.querySelector('.cx-time-panel');
        const sidebar = document.querySelector('.sidebar');
        const left = Math.max(panel?.getBoundingClientRect().right || 0, sidebar?.getBoundingClientRect().right || 0) - mapBox.left;
        const offset = Math.max(0, left) * container.clientWidth / mapBox.width / 2;
        map.easeTo({ center: feature.geometry.coordinates, zoom, offset: [Math.max(0, offset - 40), 0], duration: 500 });
        map.getCanvas().focus({ preventScroll: true });
      } catch { if (!disposed) onError(); }
      finally { expanding = false; }
    });
    root.append(button);
    const marker = new Marker({ element: root, anchor: 'center' }).setLngLat(feature.geometry.coordinates).addTo(map);
    return { marker, tooltip, button, signature: summary.description };
  };
  const update = () => {
    if (!map.getSource('cx-objects') || !map.isSourceLoaded('cx-objects')) return;
    const active = new Set();
    const width = container.clientWidth;
    const height = container.clientHeight;
    const mapBox = container.getBoundingClientRect();
    const panel = container.closest('.workspace-grid')?.querySelector('.cx-time-panel');
    const sidebar = document.querySelector('.sidebar');
    const coveredLeft = Math.max(panel?.getBoundingClientRect().right || 0, sidebar?.getBoundingClientRect().right || 0) - mapBox.left;
    const leftEdge = Math.max(0, coveredLeft) * width / mapBox.width;
    for (const feature of map.querySourceFeatures('cx-objects')) {
      if (!feature.properties.cluster) continue;
      const id = feature.properties.cluster_id;
      if (active.has(id)) continue;
      const pixel = map.project(feature.geometry.coordinates);
      if (pixel.x < 0 || pixel.x > width || pixel.y < 0 || pixel.y > height) continue;
      active.add(id);
      let entry = markers.get(id);
      if (entry && entry.signature !== objectClusterSummary(feature.properties).description) { remove(entry); entry = null; }
      if (!entry) { entry = create(feature); markers.set(id, entry); }
      entry.marker.setLngLat(feature.geometry.coordinates);
      const chipWidth = entry.button.offsetWidth;
      const chipHeight = entry.button.offsetHeight;
      // Keep whole labels beside panels and controls, without exposing covered points.
      entry.button.parentElement.style.visibility = pixel.x < leftEdge ? 'hidden' : '';
      entry.button.tabIndex = pixel.x < leftEdge ? -1 : 0;
      entry.marker.setOffset([
        Math.max(leftEdge + chipWidth / 2 + 8, Math.min(pixel.x, width - chipWidth / 2 - 80)) - pixel.x,
        Math.max(chipHeight / 2 + 4, Math.min(pixel.y, height - chipHeight / 2 - 4)) - pixel.y,
      ]);
    }
    for (const [id, entry] of markers) if (!active.has(id)) { remove(entry); markers.delete(id); }
  };
  const moving = () => { for (const entry of markers.values()) entry.tooltip.hidden = true; };
  map.on('render', update);
  map.on('movestart', moving);
  update();
  return () => {
    disposed = true;
    map.off('render', update);
    map.off('movestart', moving);
    for (const entry of markers.values()) remove(entry);
    markers.clear();
  };
}
