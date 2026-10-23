import { WorkflowEntrypoint } from 'cloudflare:workers';
import puppeteer from '@cloudflare/puppeteer';
import { scrapeHevyWorkouts } from '../../scrapers/hevy/scrape-workouts.mjs';
import { refreshHevy } from './hevy-refresh.js';

export class HevyRefreshWorkflow extends WorkflowEntrypoint {
  async run(event, step) {
    return refreshHevy({
      env: this.env, step, now: new Date(event.timestamp),
      scrape: async options => {
        const browser = await puppeteer.launch(this.env.HEVY_BROWSER);
        let deadline;
        try {
          const task = (async () => {
            const page = await browser.newPage();
            page.setDefaultTimeout(30_000);
            page.setDefaultNavigationTimeout(60_000);
            await page.setViewport({ width: 1440, height: 1050 });
            return scrapeHevyWorkouts(page, options);
          })();
          return await Promise.race([task, new Promise((_, reject) => {
            deadline = setTimeout(() => reject(new Error('Hevy scraping exceeded four minutes.')), 240_000);
          })]);
        } catch {
          // Browser exceptions may include authenticated URLs or page contents.
          throw new Error('The hosted Hevy scrape failed; the existing R2 report was preserved.');
        } finally {
          clearTimeout(deadline);
          await browser.close().catch(() => {});
        }
      },
    });
  }
}
