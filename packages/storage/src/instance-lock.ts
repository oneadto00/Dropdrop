import type { Instance } from "./instance-storage.js";

export function acquireInstanceLock(instance: Instance) {
  const connection = instance.database("lock.sqlite");
  try {
    connection.exec("BEGIN EXCLUSIVE");
    return connection;
  } catch (error) {
    connection.close();
    throw error;
  }
}
