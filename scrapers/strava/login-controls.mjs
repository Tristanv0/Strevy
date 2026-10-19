// This function is evaluated inside Chrome, so it must not reference module scope.
export function findVisibleLoginControl(selector, text, acceptPasswordInput = false) {
  const normalize = value => String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
  const ready = element => {
    if (!element.isConnected || !element.getClientRects().length
      || element.matches(':disabled') || element.getAttribute('aria-disabled') === 'true'
      || element.readOnly) return false;
    const bounds = element.getBoundingClientRect();
    if (bounds.width <= 0 || bounds.height <= 0) return false;
    for (let current = element; current; current = current.parentElement) {
      const style = getComputedStyle(current);
      if (style.display === 'none' || ['hidden', 'collapse'].includes(style.visibility)
        || Number(style.opacity) === 0) return false;
    }
    return true;
  };
  if (/An unexpected error occurred/i.test(document.body?.innerText || '')) {
    return { loginRejected: true };
  }
  if (acceptPasswordInput) {
    const password = [...document.querySelectorAll('input[type="password"]')].find(ready);
    if (password) return password;
  }
  return [...document.querySelectorAll(selector)].find(element => ready(element)
    && (text === undefined || [element.getAttribute('aria-label'), element.innerText, element.textContent]
      .some(label => normalize(label) === normalize(text))));
}

export async function clickLoginControl(element, delay = 60) {
  // Locator actions wait for a stable bounding box and calculate the click point
  // immediately before clicking, rather than using an earlier mouse coordinate.
  await element.asLocator().setTimeout(0).setWaitForStableBoundingBox(true).click({ delay });
}
