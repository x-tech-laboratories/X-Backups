// Writes the hash file X_BACKUPS_PASSWORD_HASH_FILE points at, through X-Libs' hash-password command, which asks at a
// terminal or reads stdin so the password never lands in argv or shell history.

import { hash_password_command } from "@x-tech-laboratories/x-libs/server/hash_password";

import { password_hash_variable } from "./passwords.ts";

// The file holds the declared admin's hash alone, under whatever name the config gives the admin.
await hash_password_command(password_hash_variable, ["admin", process.argv[2] ?? "password.hash"]);
