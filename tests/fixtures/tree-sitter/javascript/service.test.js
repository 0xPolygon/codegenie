import { loadRecord } from "./service.jsx";

describe("service", () => {
  test.only("loads a record", async () => {
    await loadRecord("one");
  });

  it.skip("preserves missing records", async () => {
    await loadRecord("missing");
  });

  test.each([["one"], ["two"]])("loads record %s", async (id) => {
    await loadRecord(id);
  });
});
