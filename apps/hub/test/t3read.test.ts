import assert from "node:assert/strict";
import { test } from "node:test";
import type { T3Worker } from "@studio/t3-bridge";
import { listProjects, readTail } from "../src/t3Worker.ts";

/** A T3 that pages its timeline the way T3 does: from the start, after an exclusive position. */
function fakeT3(count: number, keep: (i: number) => boolean = () => true) {
  const items = Array.from({ length: count }, (_, i) => ({ position: i, type: "assistant_message", text: `m${i}`, title: null, status: "completed", createdBy: null, updatedAt: "" }));
  return {
    async call(name: string, args: Record<string, number | undefined>) {
      if (name === "t3_project_list") {
        const all = Array.from({ length: 45 }, (_, i) => ({ id: `p${i}` }));
        const start = args.cursor ?? 0, end = start + (args.limit ?? 20);
        return { projects: all.slice(start, end), nextCursor: end < all.length ? end : null };
      }
      const visible = items.filter((it) => keep(it.position) && (args.afterPosition === undefined || it.position > args.afterPosition));
      const page = visible.slice(0, args.limit ?? 20);
      return { thread: { itemCount: count, status: "idle" }, items: page, nextPosition: page.at(-1)?.position ?? null, hasMore: visible.length > page.length };
    },
  } as unknown as T3Worker;
}

test("a long thread is read from its end, so new messages show", async () => {
  const { items } = await readTail(fakeT3(316), "t", { view: "activity", last: 150, maxCharsPerItem: 100 });
  assert.equal(items.length, 150);
  assert.equal(items.at(-1)!.text, "m315");
  assert.equal(items[0]!.text, "m166");
});

test("a short thread is read whole", async () => {
  const { items } = await readTail(fakeT3(8), "t", { view: "activity", last: 150, maxCharsPerItem: 100 });
  assert.deepEqual(items.map((i) => i.position), [0, 1, 2, 3, 4, 5, 6, 7]);
});

test("a view that skips most items reaches further back for enough of them", async () => {
  const { items } = await readTail(fakeT3(500, (i) => i % 10 === 0), "t", { view: "messages", last: 20, maxCharsPerItem: 100 });
  assert.equal(items.length, 20);
  assert.equal(items.at(-1)!.position, 490);
});

test("every project is listed, past T3's page of 20", async () => {
  assert.equal((await listProjects(fakeT3(0))).length, 45);
});
