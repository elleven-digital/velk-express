import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const alias = {
  "@": fileURLToPath(new URL("./src", import.meta.url)),
  // "server-only" throws outside the Next.js bundler; tests import server modules directly.
  "server-only": fileURLToPath(new URL("./test/server-only-stub.ts", import.meta.url)),
};

// Integration tests (*.int.test.ts) share one database, so they run in their
// own project with file parallelism off, and only when TEST_DATABASE_URL is set.
const integration = process.env.TEST_DATABASE_URL
  ? [
      {
        resolve: { alias },
        test: {
          name: "integration",
          environment: "node" as const,
          include: ["src/**/*.int.test.ts"],
          fileParallelism: false,
        },
      },
    ]
  : [];

export default defineConfig({
  test: {
    projects: [
      {
        resolve: { alias },
        test: {
          name: "unit",
          environment: "node",
          include: ["src/**/*.test.ts"],
          exclude: ["src/**/*.int.test.ts", "**/node_modules/**"],
        },
      },
      ...integration,
    ],
  },
});
