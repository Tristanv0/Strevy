export async function loginHevy(page, { email, password }) {
  if (!email || !password) throw new Error('Set HEVY_EMAIL and HEVY_PASSWORD in the root .env file.');
  await page.goto('https://hevy.com/login', { waitUntil: 'domcontentloaded' });
  await page.bringToFront();
  for (const [label, selector, value] of [
    ['email', 'input:not([type]), input[type="text"], input[type="email"]', email],
    ['password', 'input[type="password"]', password],
  ]) {
    console.log(`Hevy: entering ${label}.`);
    const input = await page.waitForSelector(selector, { visible: true, timeout: 30_000 });
    try {
      await input.click({ clickCount: 3 });
      await input.press('Backspace');
      await input.type(value, { delay: 20 });
    } finally {
      await input.dispose();
    }
  }
  console.log('Hevy: clicking Login.');
  const handle = await page.waitForFunction(() => [...document.querySelectorAll('button')]
    .find(button => /^log\s*in$/i.test(button.innerText.trim()) && !button.disabled
      && button.getBoundingClientRect().width > 0), { timeout: 30_000 });
  try {
    await handle.asElement().click();
  } finally {
    await handle.dispose();
  }
  const outcome = await page.waitForFunction(() => {
    if (!/^\/login\/?$/.test(location.pathname)) return 'signed-in';
    const error = document.querySelector('[role="alert"]');
    return error?.textContent.trim() ? 'rejected' : false;
  }, { timeout: 60_000 });
  try {
    if (await outcome.jsonValue() !== 'signed-in') throw new Error('Hevy rejected the login.');
  } finally {
    await outcome.dispose();
  }
  await page.waitForNetworkIdle({ idleTime: 500, timeout: 15_000 }).catch(() => {});
}
