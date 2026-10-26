// Combines the declared config file with the one the page edits, by the mode X_BACKUPS_CONFIG_MODE names.
//
// declarative: only the declared file counts and the page edits nothing. mixed: the declared file's repositories
// are locked and the page may add its own. page: the declared file is optional and the page manages the rest.
// A declared repository shadows a page one of the same name, and a declared default wins over a saved one.

// ── Imports ──────────────────────────────────────────────────────────────────

import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import {
  ConfigError, check_defaults, check_repositories, default_settings, is_plain_object, name_pattern, parse_document, read_text,
  type Config, type ConfigDocument, type RepositoryConfig,
} from "./config.ts";

// ── Shapes ───────────────────────────────────────────────────────────────────

export type ConfigMode = "declarative" | "mixed" | "page";

export interface Setting {
  name: string;
  value: number | string;
  source: "declared" | "saved" | "default";
}

export interface SourceOptions {
  mode: ConfigMode;
  declared_path: string | null;
  state_dir: string;
}

// Shown in place of a secret, and taken back as "leave it as it was".
export const SECRET_MASK = "(set)";

const modes: ConfigMode[] = ["declarative", "mixed", "page"];

// ── Sources ──────────────────────────────────────────────────────────────────

export class ConfigSources {
  readonly mode: ConfigMode;
  private readonly declared: ConfigDocument;
  private page: ConfigDocument;
  private readonly page_path: string;
  private readonly passphrase_dir: string;

  constructor(options: SourceOptions) {
    this.mode = options.mode;
    if (options.declared_path === null && this.mode !== "page") {
      throw new Error(`X_BACKUPS_CONFIG is not set; point it at the repositories JSON file, or set X_BACKUPS_CONFIG_MODE=page.`);
    }
    this.declared = options.declared_path === null ? empty_document() : parse_document(read_text(options.declared_path), options.declared_path);
    this.page_path = join(options.state_dir, "config.json");
    this.passphrase_dir = join(options.state_dir, "passphrases");
    this.page = this.mode !== "declarative" && existsSync(this.page_path) ? parse_document(read_text(this.page_path), this.page_path) : empty_document();
  }

  static from_environment(): ConfigSources {
    const mode = (process.env.X_BACKUPS_CONFIG_MODE || "declarative") as ConfigMode;
    if (!modes.includes(mode)) throw new Error(`X_BACKUPS_CONFIG_MODE must be ${modes.join(", ")}, not '${mode}'.`);
    return new ConfigSources({
      mode,
      declared_path: process.env.X_BACKUPS_CONFIG || null,
      state_dir: process.env.X_BACKUPS_STATE_DIR ?? "state",
    });
  }

  get editable(): boolean {
    return this.mode !== "declarative";
  }

  // ── Reading ──────────────────────────────────────────────────────────────

  // Every repository to watch: the declared ones, then the page's that no declared one shadows.
  config(): Config {
    const defaults = this.defaults();
    const declared = check_repositories(this.declared.repositories, defaults, "declared");
    const taken = new Set(declared.map((repository) => repository.name));
    const page = check_repositories(this.page.repositories.filter((entry) => !taken.has(String(entry.name))), defaults, "page");
    return { repositories: [...declared, ...page] };
  }

  // Page repositories a declared one of the same name hides, so the page can say so.
  shadowed(): string[] {
    const declared = new Set(this.declared.repositories.map((entry) => String(entry.name)));
    return this.page.repositories.map((entry) => String(entry.name)).filter((name) => declared.has(name));
  }

  source_of(name: string): RepositoryConfig["source"] | null {
    if (this.declared.repositories.some((entry) => entry.name === name)) return "declared";
    if (this.page.repositories.some((entry) => entry.name === name)) return "page";
    return null;
  }

  // The entry as written, with secrets masked, for the page to show or edit.
  entry(name: string): Record<string, unknown> | null {
    const entry = [...this.declared.repositories, ...this.page.repositories].find((item) => item.name === name);
    return entry === undefined ? null : mask(entry);
  }

  // Each default with the value in force and where it came from.
  settings(): Setting[] {
    return Object.entries(default_settings).map(([name, { fallback }]) => {
      if (this.declared.defaults[name] !== undefined) return { name, value: this.declared.defaults[name] as number | string, source: "declared" };
      if (this.page.defaults[name] !== undefined) return { name, value: this.page.defaults[name] as number | string, source: "saved" };
      return { name, value: fallback, source: "default" };
    });
  }

  private defaults(): Record<string, unknown> {
    return { ...this.page.defaults, ...this.declared.defaults };
  }

  // ── Writing ──────────────────────────────────────────────────────────────

  // Adds the page repository, or replaces the one of the same name, after checking the whole config still holds.
  save_repository(entry: Record<string, unknown>, replacing: string | null): Config {
    this.refuse_unless_editable();
    if (!is_plain_object(entry)) throw new ConfigError("The repository must be an object.");
    const name = String(entry.name ?? "");
    if (!name_pattern.test(name)) throw new ConfigError("The name must be letters, digits, '.', '_' or '-'.", "name");
    if (replacing !== null && name !== replacing) throw new ConfigError("A repository cannot be renamed; add a new one instead.", "name");
    if (this.declared.repositories.some((item) => item.name === name)) {
      throw new ConfigError(`'${name}' is declared in the Nix configuration, so it is changed there.`, "name");
    }
    const previous = this.page.repositories.find((item) => item.name === name) ?? null;
    if (replacing === null && previous !== null) throw new ConfigError(`A repository named '${name}' already exists.`, "name");
    if (replacing !== null && previous === null) throw new ConfigError(`No page repository named '${name}'.`, "name");

    const cleaned = this.with_secrets_kept(entry, previous);
    const repositories = [...this.page.repositories.filter((item) => item.name !== name), cleaned.entry];
    const next = { ...this.page, repositories };
    const config = this.checked({ next });
    if (cleaned.passphrase !== null) this.write_passphrase(name, cleaned.passphrase);
    this.write(next);
    return config;
  }

  delete_repository(name: string): Config {
    this.refuse_unless_editable();
    if (this.source_of(name) === "declared") throw new ConfigError(`'${name}' is declared in the Nix configuration, so it is removed there.`);
    const next = { ...this.page, repositories: this.page.repositories.filter((item) => item.name !== name) };
    const config = this.checked({ next });
    this.write(next);
    return config;
  }

  // Saves the defaults the declared file leaves open; an empty value goes back to the built-in one.
  save_defaults(values: Record<string, unknown>): Config {
    this.refuse_unless_editable();
    const defaults = { ...this.page.defaults };
    for (const [name, value] of Object.entries(values)) {
      if (this.declared.defaults[name] !== undefined) throw new ConfigError(`${name} is declared in the Nix configuration, so it is changed there.`, name);
      if (value === null || value === "") delete defaults[name];
      else defaults[name] = value;
    }
    check_defaults(defaults, "Defaults");
    const next = { ...this.page, defaults };
    const config = this.checked({ next });
    this.write(next);
    return config;
  }

  private refuse_unless_editable(): void {
    if (!this.editable) throw new ConfigError("The config is declarative here: change it in the Nix configuration.");
  }

  // The whole config as it would be with the page document replaced, which throws before anything is written.
  private checked({ next }: { next: ConfigDocument }): Config {
    const current = this.page;
    this.page = next;
    try {
      return this.config();
    } catch (error) {
      this.page = current;
      throw error;
    }
  }

  // A masked secret keeps the previous value; a typed passphrase goes to its own file, never into the JSON.
  private with_secrets_kept(entry: Record<string, unknown>, previous: Record<string, unknown> | null): { entry: Record<string, unknown>; passphrase: string | null } {
    const result: Record<string, unknown> = {};
    for (const [field, value] of Object.entries(entry)) {
      if (value === null || value === undefined || value === "") continue;
      if (value === SECRET_MASK) {
        if (previous?.[field] !== undefined) result[field] = previous[field];
        continue;
      }
      result[field] = value;
    }
    let passphrase: string | null = null;
    if (typeof result.passphrase === "string") {
      passphrase = result.passphrase;
      delete result.passphrase;
      result.passphrase_file = this.passphrase_path(String(entry.name));
    } else if (previous?.passphrase_file === this.passphrase_path(String(entry.name)) && result.passphrase_file === undefined && result.passphrase_command === undefined) {
      // A passphrase stored earlier stays in use until another way to get one is given.
      result.passphrase_file = previous.passphrase_file;
    }
    return { entry: result, passphrase };
  }

  private passphrase_path(name: string): string {
    return join(this.passphrase_dir, name);
  }

  private write_passphrase(name: string, passphrase: string): void {
    write_private(this.passphrase_path(name), passphrase);
  }

  private write(document: ConfigDocument): void {
    write_private(this.page_path, `${JSON.stringify(document, null, 2)}\n`);
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function empty_document(): ConfigDocument {
  return { defaults: {}, repositories: [] };
}

// Writes beside the file and renames over it, so a crash never leaves half a file, readable only by this user.
function write_private(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, text, { mode: 0o600 });
  renameSync(temporary, path);
}

// The entry with any secret it holds replaced by the mask.
export function mask(entry: Record<string, unknown>): Record<string, unknown> {
  const masked = { ...entry };
  for (const field of ["passphrase", "passphrase_command"]) {
    if (masked[field] !== undefined && masked[field] !== null) masked[field] = SECRET_MASK;
  }
  return masked;
}
