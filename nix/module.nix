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
    repositories = lib.mapAttrsToList repository_entry cfg.repositories;
  };

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
      description = "File holding the login password hash written by `npm run hash-password`.";
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
    assertions = lib.mapAttrsToList (name: repository: {
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
      ];

      environment = {
        HOST = cfg.host;
        PORT = toString cfg.port;
        X_BACKUPS_CONFIG = toString config_file;
        X_BACKUPS_PASSWORD_HASH_FILE = "${credentials_directory}/password-hash";
        X_BACKUPS_STATE_DIR = "/var/lib/x-backups";
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
