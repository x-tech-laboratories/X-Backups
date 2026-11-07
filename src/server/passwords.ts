// Password hashes from X-Libs, and the one hash file the declared admin logs in with: a bare hash, or one `name:hash`
// line as `npm run hash-password` writes it.

import { load_accounts } from "@x-tech-laboratories/x-libs/server/passwords";

export { hash_password, verify_password } from "@x-tech-laboratories/x-libs/server/passwords";

// The environment variable naming the hash file.
export const password_hash_variable = "X_BACKUPS_PASSWORD_HASH_FILE";

export function load_password_hash(file_path: string | undefined = process.env[password_hash_variable]): string {
  if (!file_path) throw new Error(`${password_hash_variable} is not set; create one with \`npm run hash-password -- <file>\`.`);
  const accounts = load_accounts(password_hash_variable, file_path);
  if (accounts.size !== 1) throw new Error(`${file_path} must hold the declared admin's hash alone, not ${accounts.size} users.`);
  return [...accounts.values()][0];
}
