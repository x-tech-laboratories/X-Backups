self:
{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.services.x-backups;
  inherit (lib)
    literalExpression
    mkEnableOption
    mkIf
    mkOption
    types
    ;

  json = pkgs.formats.json { };

  # systemd places each loaded secret here, readable only by the service.
  credentials_directory = "/run/credentials/x-backups.service";

  nullable_options = [
    "host"
    "address"
  ];

  # A typed option left unset is left out, so an entry holds only what was declared.
  entry =
    name: fields:
    lib.filterAttrs (field: value: !(lib.elem field nullable_options && value == null)) fields
    // {
      inherit name;
    };

  repository_entry =
    name: repository:
    entry name (removeAttrs repository [ "passphraseFile" ])
    // lib.optionalAttrs (repository.passphraseFile != null) {
      passphrase_file = "${credentials_directory}/passphrase-${name}";
    };

  # A kind with no entries is left out, so a setup of flat repositories writes the same file as before.
  entity_lists = lib.filterAttrs (_: list: list != [ ]) {
    hosts = lib.mapAttrsToList entry cfg.hosts;
    sources = lib.mapAttrsToList entry cfg.sources;
    jobs = lib.mapAttrsToList entry cfg.jobs;
  };

  config_file = json.generate "x-backups.json" (
    {
      inherit (cfg) defaults;
      repositories = lib.mapAttrsToList repository_entry cfg.repositories;
    }
    // entity_lists
  );

  # The page may add borg 2 repositories too, so only a declared-only setup without one goes without borg2.
  needs_borg2 =
    cfg.configMode != "declarative" || lib.any (repository: (repository.borg_version or 1) == 2) (lib.attrValues cfg.repositories);

  passphrase_credentials = lib.mapAttrsToList (name: repository: "passphrase-${name}:${repository.passphraseFile}") (
    lib.filterAttrs (_: repository: repository.passphraseFile != null) cfg.repositories
  );

  # A flat repository entry with paths expands into a source of its name, which a job may name too.
  declared_sources =
    lib.attrNames cfg.sources
    ++ lib.attrNames (lib.filterAttrs (_: repository: repository ? source_paths) cfg.repositories);

  undeclared = names: declared: lib.filter (name: !lib.elem name declared) names;

  # Only a declarative setup holds every source and repository here; in the other modes the page may add the rest.
  job_assertions = lib.optionals (cfg.configMode == "declarative") (
    lib.concatLists (
      lib.mapAttrsToList (name: job: [
        {
          assertion = undeclared job.sources declared_sources == [ ];
          message = "services.x-backups.jobs.${name}: no source named ${lib.concatStringsSep ", " (undeclared job.sources declared_sources)} is declared in services.x-backups.sources, and configMode is declarative so the page cannot add one.";
        }
        {
          assertion = undeclared job.repositories (lib.attrNames cfg.repositories) == [ ];
          message = "services.x-backups.jobs.${name}: no repository named ${lib.concatStringsSep ", " (undeclared job.repositories (lib.attrNames cfg.repositories))} is declared in services.x-backups.repositories, and configMode is declarative so the page cannot add one.";
        }
      ]) cfg.jobs
    )
  );

  # The freeform fields of an entity, beside typed options for the ones it is known by.
  entity =
    options:
    types.attrsOf (
      types.submodule {
        freeformType = json.type;
        inherit options;
      }
    );
in
{
  imports = [
    (lib.mkRemovedOptionModule [ "services" "x-backups" "sshKeyFile" ] ''
      X-Backups no longer logs in to hosts over SSH: each managed host runs the X-Backups agent
      (nixosModules.agent), which dials the server with its own token. A key borg itself uses for
      an ssh:// repository is the repository's ssh_key or rsh.
    '')
  ];

  options.services.x-backups = {
    enable = mkEnableOption "X-Backups, a web platform for managing borg backups";

    package = mkOption {
      type = types.package;
      default = self.packages.${pkgs.stdenv.hostPlatform.system}.default;
      defaultText = literalExpression "x-backups (from flake)";
      description = "The X-Backups package to use.";
    };

    host = mkOption {
      type = types.str;
      default = "127.0.0.1";
      description = "Address the web page and API listen on.";
    };

    port = mkOption {
      type = types.port;
      default = 7710;
      description = "Port the web page and API listen on.";
    };

    openFirewall = mkOption {
      type = types.bool;
      default = false;
      description = "Open the port in the firewall.";
    };

    passwordHashFile = mkOption {
      type = types.str;
      example = "/run/secrets/x-backups-password-hash";
      description = ''
        File holding the password hash written by `npm run hash-password`, for the admin named by
        `adminName`. The page cannot change that admin's role or password; other users are added
        on its Users page.
      '';
    };

    adminName = mkOption {
      type = types.str;
      default = "admin";
      description = "The user name `passwordHashFile` logs in as.";
    };

    oidc = {
      issuer = mkOption {
        type = types.nullOr types.str;
        default = null;
        example = "https://id.example.org/realms/home";
        description = ''
          OpenID Connect issuer to log in through. Its user name claim must match an X-Backups
          user an admin has added; the provider proves who someone is, the user decides their role.
        '';
      };
      clientId = mkOption {
        type = types.str;
        default = "x-backups";
        description = "The client id registered with the provider.";
      };
      clientSecretFile = mkOption {
        type = types.nullOr types.str;
        default = null;
        description = "File holding the client secret.";
      };
      redirectUrl = mkOption {
        type = types.nullOr types.str;
        default = null;
        example = "https://backups.example.org/api/auth/oidc/callback";
        description = "The public URL of X-Backups' callback, as registered with the provider.";
      };
      label = mkOption {
        type = types.str;
        default = "single sign-on";
        description = "What the login button names the provider as.";
      };
      usernameClaim = mkOption {
        type = types.str;
        default = "preferred_username";
        description = "The ID token claim holding the X-Backups user name.";
      };
    };

    proxyLogin = {
      header = mkOption {
        type = types.nullOr types.str;
        default = null;
        example = "X-Remote-User";
        description = ''
          Header a reverse proxy that has already logged someone in sets to their user name. It is
          believed only from `proxyLogin.trustedProxies`, so the proxy must strip it from clients.
        '';
      };
      trustedProxies = mkOption {
        type = types.listOf types.str;
        default = [
          "127.0.0.1"
          "::1"
        ];
        description = "Addresses the proxy connects from.";
      };
    };

    configMode = mkOption {
      type = types.enum [
        "declarative"
        "mixed"
        "page"
      ];
      default = "declarative";
      description = ''
        Whether the web page may change the config. `declarative` shows it read-only. `mixed` keeps
        the hosts, repositories, sources, jobs and defaults set here locked, and lets the page add
        its own and set the defaults left open here. `page` is the same, for a setup that declares
        nothing here. The page keeps its part in the state directory, and an entity declared here
        replaces a page one of the same kind and name.

        Anyone who can log in to a page that edits the config can make X-Backups run commands
        (`rsh`, `borg_bin`, `passphrase_command`) as its service user on this machine and on each
        host through its agent.
      '';
    };

    defaults = mkOption {
      type = json.type;
      default = { };
      example = literalExpression ''{ interval = "30m"; max_age = "2d"; }'';
      description = ''
        Settings for every repository that does not set its own: `interval`, `max_age`,
        `warn_age`, `check_max_age`, `check_warn_age`, `canary_max_age`, `canary_warn_age` and
        `browse_limit`. The page shows these as declared and leaves them locked.
      '';
    };

    hosts = mkOption {
      default = { };
      example = literalExpression ''
        {
          # On the server; fileserver itself enables nixosModules.agent with the token issued for it:
          #   services.x-backups-agent = {
          #     enable = true;
          #     url = "wss://backups.example.org/api/agent";
          #     tokenFile = "/run/secrets/x-backups-agent-token";
          #   };
          fileserver = {
            address = "fileserver.example.org";
            require_sudo = true;
          };
          storage = {
            kind = "storage-only";
            address = "storage.example.org";
          };
          # The managed host with no address is this server, run by the agent built into it.
          server = { };
        }
      '';
      description = ''
        Hosts, keyed by name, each with the host fields of `config.example.json`. A managed host
        runs `nixosModules.agent`, pointed at this server's `/api/agent` with the token an admin
        issues on `POST /api/hosts/<name>/token`. The page shows each one as declared and locked.
      '';
      type = entity {
        kind = mkOption {
          type = types.enum [
            "managed"
            "storage-only"
          ];
          default = "managed";
          description = ''
            `managed` runs the X-Backups agent, which runs its commands; `storage-only` only holds
            repositories reached through `borg serve` or a hosted service.
          '';
        };
        address = mkOption {
          type = types.nullOr types.str;
          default = null;
          example = "fileserver.example.org";
          description = "The host's network name, shown on the page. The one managed host without one is this server.";
        };
      };
    };

    repositories = mkOption {
      default = { };
      example = literalExpression ''
        {
          offsite = {
            host = "storage";
            repo = "ssh://borg@storage.example.org/./fileserver";
            passphraseFile = "/run/secrets/borg-offsite";
          };
          # A flat entry, holding every field at once with host naming an address.
          fileserver = {
            host = "fileserver.example.org";
            repo = "ssh://borg@storage.example.org/./fileserver";
            passphraseFile = "/run/secrets/borg-fileserver";
            source_paths = [ "/srv/data" ];
          };
        }
      '';
      description = ''
        Repositories, keyed by name, each with the repository fields of `config.example.json` plus
        `passphraseFile`. The page shows each one as declared and locked.

        An entry whose `host` is not a declared host's name, or that holds fields a repository does
        not (such as `source_paths` or `keep_daily`), is a flat entry of the older shape, written
        as given and expanded by X-Backups into a host, repository, source and job of its name.
      '';
      type = entity {
        host = mkOption {
          type = types.nullOr types.str;
          default = null;
          example = "storage";
          description = "The host whose disk holds the repository; on a flat entry, the address it runs on, or none for this server.";
        };
        repo = mkOption {
          type = types.str;
          example = "ssh://borg@storage.example.org/./fileserver";
          description = "The repository's borg URL or path.";
        };
        passphraseFile = mkOption {
          type = types.nullOr types.str;
          default = null;
          example = "/run/secrets/borg-fileserver";
          description = "File on this machine holding the repository's passphrase.";
        };
      };
    };

    sources = mkOption {
      default = { };
      example = literalExpression ''
        {
          fileserver-data = {
            host = "fileserver";
            source_paths = [ "/srv/data" "/etc" ];
            exclude = [ "*.tmp" ];
          };
        }
      '';
      description = ''
        Sources, keyed by name, each with the source fields of `config.example.json`. The page shows
        each one as declared and locked.
      '';
      type = entity {
        host = mkOption {
          type = types.str;
          example = "fileserver";
          description = "The managed host the paths are on.";
        };
        source_paths = mkOption {
          type = types.listOf types.str;
          example = [ "/srv/data" ];
          description = "The paths to back up.";
        };
      };
    };

    jobs = mkOption {
      default = { };
      example = literalExpression ''
        {
          nightly = {
            sources = [ "fileserver-data" ];
            repositories = [ "offsite" ];
            keep_daily = 7;
            keep_weekly = 4;
          };
        }
      '';
      description = ''
        Jobs, keyed by name, each with the job fields of `config.example.json`, such as retention and
        `tasks`. With `configMode` declarative, each source and repository a job names must be
        declared here; otherwise the page may add it. The page shows each job as declared and locked.
      '';
      type = entity {
        sources = mkOption {
          type = types.listOf types.str;
          example = [ "fileserver-data" ];
          description = "The sources the job backs up.";
        };
        repositories = mkOption {
          type = types.listOf types.str;
          example = [ "offsite" ];
          description = "The repositories the job backs up to.";
        };
      };
    };
  };

  config = mkIf cfg.enable {
    assertions = [
      {
        assertion = cfg.oidc.issuer == null || (cfg.oidc.clientSecretFile != null && cfg.oidc.redirectUrl != null);
        message = "services.x-backups.oidc: an issuer needs clientSecretFile and redirectUrl too.";
      }
    ]
    ++ lib.mapAttrsToList (name: repository: {
      assertion = !(repository ? passphrase);
      message = "services.x-backups.repositories.${name}: use passphraseFile, since passphrase would land in the Nix store.";
    }) cfg.repositories
    ++ job_assertions;

    systemd.services.x-backups = {
      description = "X-Backups";
      wantedBy = [ "multi-user.target" ];
      wants = [ "network-online.target" ];
      after = [ "network-online.target" ];
      restartTriggers = [ config_file ];

      # Borg on this machine reaches an ssh:// repository through ssh.
      path = [
        pkgs.openssh
        pkgs.borgbackup
      ]
      ++ lib.optional needs_borg2 self.packages.${pkgs.stdenv.hostPlatform.system}.borg2;

      environment = {
        HOST = cfg.host;
        PORT = toString cfg.port;
        X_BACKUPS_CONFIG = toString config_file;
        X_BACKUPS_PASSWORD_HASH_FILE = "${credentials_directory}/password-hash";
        X_BACKUPS_STATE_DIR = "/var/lib/x-backups";
        X_BACKUPS_CONFIG_MODE = cfg.configMode;
        X_BACKUPS_ADMIN_NAME = cfg.adminName;
      }
      // lib.optionalAttrs (cfg.oidc.issuer != null) {
        X_BACKUPS_OIDC_ISSUER = cfg.oidc.issuer;
        X_BACKUPS_OIDC_CLIENT_ID = cfg.oidc.clientId;
        X_BACKUPS_OIDC_CLIENT_SECRET_FILE = "${credentials_directory}/oidc-client-secret";
        X_BACKUPS_OIDC_REDIRECT_URL = cfg.oidc.redirectUrl;
        X_BACKUPS_OIDC_LABEL = cfg.oidc.label;
        X_BACKUPS_OIDC_USERNAME_CLAIM = cfg.oidc.usernameClaim;
      }
      // lib.optionalAttrs (cfg.proxyLogin.header != null) {
        X_BACKUPS_PROXY_USER_HEADER = cfg.proxyLogin.header;
        X_BACKUPS_TRUSTED_PROXIES = lib.concatStringsSep "," cfg.proxyLogin.trustedProxies;
      };

      serviceConfig = {
        ExecStart = lib.getExe cfg.package;
        DynamicUser = true;
        StateDirectory = "x-backups";
        StateDirectoryMode = "0700";
        LoadCredential = [
          "password-hash:${cfg.passwordHashFile}"
        ]
        ++ lib.optional (cfg.oidc.issuer != null) "oidc-client-secret:${cfg.oidc.clientSecretFile}"
        ++ passphrase_credentials;
        Restart = "on-failure";
        RestartSec = "5s";
        # A restart stops only the server, so the long runs its built-in agent started, such as a backup, carry on and
        # are followed again from their output under the state directory.
        KillMode = "process";

        CapabilityBoundingSet = "";
        LockPersonality = true;
        NoNewPrivileges = true;
        PrivateDevices = true;
        ProtectClock = true;
        ProtectControlGroups = true;
        ProtectHome = true;
        ProtectHostname = true;
        ProtectKernelLogs = true;
        ProtectKernelModules = true;
        ProtectKernelTunables = true;
        ProtectSystem = "strict";
        RestrictAddressFamilies = [
          "AF_INET"
          "AF_INET6"
          "AF_UNIX"
        ];
        RestrictNamespaces = true;
        RestrictRealtime = true;
        SystemCallArchitectures = "native";
        SystemCallFilter = [ "@system-service" ];
        UMask = "0077";
      };
    };

    networking.firewall.allowedTCPPorts = mkIf cfg.openFirewall [ cfg.port ];
  };
}
