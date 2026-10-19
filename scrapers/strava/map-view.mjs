// Capture Strava's rendered map, including its controls and provider attribution.
export async function mapViewPng(page) {
  // Strava may defer map initialization while its tab is in the background.
  await page.bringToFront();
  const handle = await page.waitForFunction(() => {
    const candidates = [window.pageView?._currentMapNode,
      ...document.querySelectorAll('#map-canvas, .mapboxgl-map, .maplibregl-map, .leaflet-container')];
    return candidates.find(element => {
      if (!(element instanceof Element) || !element.isConnected) return false;
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 100 && rect.height > 100
        && style.display !== 'none' && style.visibility !== 'hidden';
    }) || false;
  }, { timeout: 15_000 });
  const map = handle.asElement();
  try {
    await map.scrollIntoView();
    await page.waitForFunction(element => {
      const canvases = [...element.querySelectorAll('canvas')];
      const images = [...element.querySelectorAll('img')];
      return canvases.some(canvas => canvas.width > 100 && canvas.height > 100)
        || images.some(image => image.complete && image.naturalWidth > 100 && image.naturalHeight > 100);
    }, { timeout: 15_000 }, map);
    // Scrolling can trigger lazy map tiles. Allow them to settle before capturing.
    await page.waitForNetworkIdle({ idleTime: 500, timeout: 15_000 }).catch(() => {});
    await map.evaluate(() => new Promise(resolve => {
      requestAnimationFrame(() => requestAnimationFrame(resolve));
    }));
    const png = Buffer.from(await map.screenshot({ type: 'png' }));
    return {
      dataUrl: `data:image/png;base64,${png.toString('base64')}`,
      width: png.readUInt32BE(16), height: png.readUInt32BE(20),
    };
  } finally {
    await handle.dispose();
  }
}
