// Only normalized drawing coordinates leave this function; GPS stays in memory.
export function normalizeRoute(latlng, privacy, { size = 768, padding = 40 } = {}) {
  if (!Array.isArray(latlng) || !Array.isArray(privacy) || privacy.length !== latlng.length) return [];
  const segments = [];
  let segment = [];
  let previousLongitude;
  const finishSegment = () => {
    if (segment.length > 1) segments.push(segment);
    segment = [];
  };
  for (let index = 0; index < latlng.length; index += 1) {
    const point = latlng[index];
    // Strava's privacy stream uses zero for visible samples. Unknown flags are hidden.
    if ((privacy[index] !== 0 && privacy[index] !== false) || !Array.isArray(point)
      || point.length !== 2 || !point.every(Number.isFinite)
      || Math.abs(point[0]) > 85 || Math.abs(point[1]) > 180) {
      finishSegment();
      continue;
    }
    let longitude = point[1];
    if (previousLongitude !== undefined) {
      while (longitude - previousLongitude > 180) longitude -= 360;
      while (longitude - previousLongitude < -180) longitude += 360;
    }
    previousLongitude = longitude;
    const latitude = point[0] * Math.PI / 180;
    segment.push([longitude * Math.PI / 180, -Math.log(Math.tan(Math.PI / 4 + latitude / 2))]);
  }
  finishSegment();
  const points = segments.flat();
  if (points.length < 2) return [];
  let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity;
  for (const [x, y] of points) {
    minX = Math.min(minX, x); minY = Math.min(minY, y);
    maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
  }
  const span = Math.max(maxX - minX, maxY - minY);
  if (span <= 0) return [];
  const scale = (size - padding * 2) / span;
  const offsetX = (size - (maxX - minX) * scale) / 2;
  const offsetY = (size - (maxY - minY) * scale) / 2;
  return segments.map(segment => segment.map(([x, y]) => [
    Number(((x - minX) * scale + offsetX).toFixed(2)),
    Number(((y - minY) * scale + offsetY).toFixed(2)),
  ]));
}

export function approvedPhotoUrl(raw) {
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || url.username || url.password) return null;
    const approved = url.hostname.endsWith('.cloudfront.net')
      || url.hostname === 'strava.com' || url.hostname.endsWith('.strava.com');
    return approved ? url.href : null;
  } catch {
    return null;
  }
}

export function selectOwnPhotos(items, activityId, athleteId) {
  const selected = new Map();
  for (const item of items) {
    if (String(item.activity_id_str || item.activity_id) !== String(activityId)
      || String(item.owner_id) !== String(athleteId) || Number(item.media_type) !== 1) continue;
    const url = approvedPhotoUrl(item.large || item.thumbnail);
    const id = String(item.photo_id || item.id || '');
    if (url && id) selected.set(id, { id, url });
  }
  return [...selected.values()];
}

export async function routePng(renderer, segments, size = 768) {
  return renderer.evaluate(({ segments, size }) => {
    const canvas = document.createElement('canvas');
    canvas.width = size; canvas.height = size;
    const context = canvas.getContext('2d');
    context.strokeStyle = '#fc5200';
    context.lineWidth = 6;
    context.lineCap = 'round'; context.lineJoin = 'round';
    for (const segment of segments) {
      context.beginPath();
      segment.forEach(([x, y], index) => index === 0 ? context.moveTo(x, y) : context.lineTo(x, y));
      context.stroke();
    }
    return canvas.toDataURL('image/png');
  }, { segments, size });
}
