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

  repository_entry =
    name: repository:
    removeAttrs repository [ "passphraseFile" ]
    // {
      inherit name;
    }
    // lib.optionalAttrs (repository.passphraseFile != null) {
      passphrase_file = "${credentials_directory}/passphrase-${name}";
    };

  config_file = json.generate "x-backups.json" {
    inherit (cfg) defaults;
    repositories = lib.mapAttrsToList repository_entry cfg.repositories;
  };

  # The page may add borg 2 repositories too, so only a declared-only setup without one goes without borg2.
  needs_borg2 =
    cfg.configMode != "declarative" || lib.any (repository: (repository.borg_version or 1) == 2) (lib.attrValues cfg.repositories);

  passphrase_credentials = lib.mapAttrsToList (name: repository: "passphrase-${name}:${repository.passphraseFile}") (
    lib.filterAttrs (_: repository: repository.passphraseFile != null) cfg.repositories
  );
in
{
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

    sshKeyFile = mkOption {
      type = types.nullOr types.str;
      default = null;
      example = "/run/secrets/x-backups-ssh-key";
      description = ''
        Private key X-Backups logs in to repository hosts with. Host keys come from the system's
        known hosts, so list each host in `programs.ssh.knownHosts`.
      '';
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
        the repositories and defaults set here locked, and lets the page add its own repositories
        and set the defaults left open here. `page` is the same, for a setup that declares nothing
        here. The page keeps its part in the state directory, and a repository declared here
        replaces a page one of the same name.

        Anyone who can log in to a page that edits the config can make X-Backups run commands
        (`rsh`, `borg_bin`, `passphrase_command`) as its service user on this machine and over SSH.
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

    repositories = mkOption {
      default = { };
      example = literalExpression ''
        {
          fileserver = {
            host = "fileserver.example.org";
            ssh_user = "backup";
            repo = "ssh://borg@storage.example.org/./fileserver";
            passphraseFile = "/run/secrets/borg-fileserver";
            max_age = "1d";
            require_sudo = true;
          };
        }
      '';
      description = ''
        Repositories to watch, keyed by name. Each takes the fields of an entry in
        `config.example.json` other than `name`, plus `passphraseFile`.
      '';
      type = types.attrsOf (
        types.submodule {
          freeformType = json.type;
          options.passphraseFile = mkOption {
            type = types.nullOr types.str;
            default = null;
            example = "/run/secrets/borg-fileserver";
            description = "File on this machine holding the repository's passphrase.";
          };
        }
      );
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
    }) cfg.repositories;

    systemd.services.x-backups = {
      description = "X-Backups";
      wantedBy = [ "multi-user.target" ];
      wants = [ "network-online.target" ];
      after = [ "network-online.target" ];
      restartTriggers = [ config_file ];

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
      }
      // lib.optionalAttrs (cfg.sshKeyFile != null) {
        X_BACKUPS_SSH_KEY_FILE = "${credentials_directory}/ssh-key";
      };

      serviceConfig = {
        ExecStart = lib.getExe cfg.package;
        DynamicUser = true;
        StateDirectory = "x-backups";
        StateDirectoryMode = "0700";
        LoadCredential = [
          "password-hash:${cfg.passwordHashFile}"
        ]
        ++ lib.optional (cfg.sshKeyFile != null) "ssh-key:${cfg.sshKeyFile}"
        ++ lib.optional (cfg.oidc.issuer != null) "oidc-client-secret:${cfg.oidc.clientSecretFile}"
        ++ passphrase_credentials;
        Restart = "on-failure";
        RestartSec = "5s";

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
