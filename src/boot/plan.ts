export type BootInput = { dbIsEmpty: boolean; pendingMigrations: number; skipBackup: boolean };
export type BootPlan = { backup: boolean; migrate: boolean };

/** A fresh database has nothing to lose, so only an existing one is backed up. */
export function planBoot(input: BootInput): BootPlan {
  const migrate = input.pendingMigrations > 0;
  return { migrate, backup: migrate && !input.dbIsEmpty && !input.skipBackup };
}
