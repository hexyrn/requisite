import { waitForDatabase } from '../wait-for-database';

describe('waitForDatabase', () => {
  it('returns as soon as the database answers', async () => {
    const url = process.env.TEST_DATABASE_URL;
    if (!url) return; // needs a database
    await expect(waitForDatabase(url, { timeoutMs: 5000 })).resolves.toBeUndefined();
  });

  it('retries with backoff and then fails clearly when the database never appears', async () => {
    let t = 0;
    const sleeps: number[] = [];
    await expect(
      waitForDatabase('postgres://nobody:x@127.0.0.1:1/none', {
        timeoutMs: 10_000,
        initialDelayMs: 1000,
        maxDelayMs: 4000,
        now: () => t,
        sleep: async (ms) => {
          sleeps.push(ms);
          t += ms;
        },
      }),
    ).rejects.toThrow(/did not become available.*Requisite Database/);
    expect(sleeps.slice(0, 4)).toEqual([1000, 2000, 4000, 4000]);
  });
});
