export function isMediaKey(key) {
  return /^media\/\d+\/(?:route|map|photo-\d+)\.png$/.test(key);
}

export function withMediaUrl(media, baseUrl) {
  if (!media?.path) return media;
  return { ...media, url: `${baseUrl}/${media.path}` };
}
