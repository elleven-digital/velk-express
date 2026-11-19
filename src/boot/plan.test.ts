import { describe, expect, it } from "vitest";
import { planBoot } from "./plan";

describe("planBoot", () => {
  it("migrates an empty database without a backup", () => {
    expect(planBoot({ dbIsEmpty: true, pendingMigrations: 1, skipBackup: false })).toEqual({ backup: false, migrate: true });
  });
  it("backs up before migrating an existing database", () => {
    expect(planBoot({ dbIsEmpty: false, pendingMigrations: 2, skipBackup: false })).toEqual({ backup: true, migrate: true });
  });
  it("skips the backup when asked to", () => {
    expect(planBoot({ dbIsEmpty: false, pendingMigrations: 2, skipBackup: true })).toEqual({ backup: false, migrate: true });
  });
  it("does nothing when no migration is pending", () => {
    expect(planBoot({ dbIsEmpty: false, pendingMigrations: 0, skipBackup: false })).toEqual({ backup: false, migrate: false });
  });
});
