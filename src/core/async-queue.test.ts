import { test } from 'node:test';
import * as assert from 'node:assert';
import { AsyncQueue } from './async-queue';

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test('runs tasks strictly one at a time, in order', async () => {
  const q = new AsyncQueue();
  const order: number[] = [];
  let running = 0;
  let maxRunning = 0;

  const tasks = [3, 1, 2].map((id, index) =>
    q.run(async () => {
      running++;
      maxRunning = Math.max(maxRunning, running);
      await delay(10 - index * 3);
      order.push(id);
      running--;
      return id;
    })
  );

  const results = await Promise.all(tasks);
  assert.deepStrictEqual(order, [3, 1, 2]);
  assert.deepStrictEqual(results, [3, 1, 2]);
  assert.strictEqual(maxRunning, 1);
});

test('a failing task does not poison the queue', async () => {
  const q = new AsyncQueue();
  const failed = q.run(async () => {
    throw new Error('boom');
  });
  const ok = q.run(async () => 42);
  await assert.rejects(failed, /boom/);
  assert.strictEqual(await ok, 42);
  assert.strictEqual(q.idle, true);
});
