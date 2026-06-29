import { afterEach, beforeEach } from "vitest";

beforeEach(() => {
  delete process.env.WORKER_DEFAULT_REPO;
});

afterEach(() => {
  delete process.env.WORKER_DEFAULT_REPO;
});
