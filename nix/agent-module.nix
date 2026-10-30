self:
{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.services.x-backups-agent;
  inherit (lib)
    literalExpression
    mkEnableOption
    mkIf
    mkOption
    types
    ;

  packages = self.packages.${pkgs.stdenv.hostPlatform.system};

  default_name = "x-backups-agent";
  state_directory = "/var/lib/x-backups-agent";
  credentials_directory = "/run/credentials/x-backups-agent.service";

  # systemd's path takes folders above bin, so a folder given with its bin is trimmed back to that.
  path_entry = entry: if lib.isString entry then lib.removeSuffix "/bin" entry else entry;
in
{
  options.services.x-backups-agent = {
    enable = mkEnableOption "the X-Backups agent, which runs backups on this host for an X-Backups server";

    package = mkOption {
      type = types.package;
      default = packages.agent;
      defaultText = literalExpression "x-backups-agent (from flake)";
      description = "The X-Backups agent package to use.";
    };

    url = mkOption {
      type = types.strMatching "wss?://.+";
      example = "wss://backups.example.org/api/agent";
      description = ''
        The server's agent endpoint. It must be `wss://`, since repository passphrases travel
        over it; `ws://` is only accepted to this machine. The server's certificate is checked
        against the system's CA bundle, so an internal CA in `security.pki.certificates` is trusted.
      '';
    };

    keyFile = mkOption {
      type = types.nullOr types.str;
      default = null;
      example = "/run/secrets/x-backups-agent-key";
      description = ''
        File holding this host's unencrypted OpenSSH ed25519 private key, made with
        `ssh-keygen -t ed25519 -N "" -C x-backups-agent-<host>`. The server declares its public
        line as the host's `agent_public_key`. Give this or `tokenFile`, not both.
      '';
    };

    tokenFile = mkOption {
      type = types.nullOr types.str;
      default = null;
      example = "/run/secrets/x-backups-agent-token";
      description = ''
        File holding the token the server issued for this host on its Hosts page, for a host
        with no declared key. Give this or `keyFile`, not both.
      '';
    };

    host = mkOption {
      type = types.str;
      default = lib.toLower config.networking.hostName;
      defaultText = literalExpression "lib.toLower config.networking.hostName";
      example = "fileserver.example.org";
      description = ''
        The name the agent reports. With `keyFile` it is the host it logs in as, so it must be
        the host's name in the server's config.
      '';
    };

    user = mkOption {
      type = types.str;
      default = default_name;
      description = ''
        User the agent and the commands it runs run as. The default is a system user made for
        it; borg must be able to read every source, through its groups or the sudo rules that
        `require_sudo` needs (see the README).
      '';
    };

    group = mkOption {
      type = types.str;
      default = default_name;
      description = "Group the agent runs as.";
    };

    extraGroups = mkOption {
      type = types.listOf types.str;
      default = [ ];
      example = [ "users" ];
      description = "Further groups for the agent's user, such as one that may read the sources.";
    };

    borg2 = mkOption {
      type = types.bool;
      default = false;
      description = "Put borg 2 beside borg 1 on the agent's PATH, for repositories with `borg_version: 2`.";
    };

    path = mkOption {
      type = types.listOf (types.either types.package types.str);
      default = [ ];
      example = literalExpression ''[ "/run/current-system/sw" pkgs.rsync ]'';
      description = ''
        Packages or folders put on the service's PATH ahead of its own borg, ssh and core tools,
        such as `/run/current-system/sw` for the system's programs. `/run/wrappers/bin` comes first
        always, so `sudo` is the setuid one.
      '';
    };
  };

  config = mkIf cfg.enable {
    assertions = [
      {
        assertion = (cfg.keyFile == null) != (cfg.tokenFile == null);
        message = "services.x-backups-agent: give exactly one of keyFile and tokenFile.";
      }
    ];

    users.users.${cfg.user} = lib.mkMerge [
      { inherit (cfg) extraGroups; }
      (mkIf (cfg.user == default_name) {
        isSystemUser = true;
        inherit (cfg) group;
        home = state_directory;
      })
    ];
    users.groups = mkIf (cfg.group == default_name) { ${default_name} = { }; };

    systemd.services.x-backups-agent = {
      description = "X-Backups agent";
      wantedBy = [ "multi-user.target" ];
      wants = [ "network-online.target" ];
      after = [ "network-online.target" ];

      path = [
        "/run/wrappers"
      ]
      ++ map path_entry cfg.path
      ++ [
        pkgs.bash
        pkgs.openssh
        pkgs.borgbackup
        pkgs.util-linux
      ]
      ++ lib.optional cfg.borg2 packages.borg2;

      environment = {
        X_BACKUPS_AGENT_URL = cfg.url;
        X_BACKUPS_AGENT_HOST = cfg.host;
        X_BACKUPS_AGENT_STATE_DIR = state_directory;
        HOME = state_directory;
        # Node keeps its own CA list, so the system bundle, which holds security.pki.certificates, is added to it.
        NODE_EXTRA_CA_CERTS = "/etc/ssl/certs/ca-certificates.crt";
      }
      // (
        if cfg.keyFile != null then
          { X_BACKUPS_AGENT_KEY_FILE = "${credentials_directory}/key"; }
        else
          { X_BACKUPS_AGENT_TOKEN_FILE = "${credentials_directory}/token"; }
      );

      serviceConfig = {
        ExecStart = lib.getExe cfg.package;
        User = cfg.user;
        Group = cfg.group;
        StateDirectory = "x-backups-agent";
        StateDirectoryMode = "0700";
        CacheDirectory = "x-backups-agent";
        CacheDirectoryMode = "0700";
        LoadCredential = if cfg.keyFile != null then [ "key:${cfg.keyFile}" ] else [ "token:${cfg.tokenFile}" ];
        Restart = "always";
        RestartSec = "5s";
        # A restart stops only the agent, so a backup it started keeps going and is picked up again.
        KillMode = "process";
        # Borg reads sources under /home, and require_sudo runs sudo, so neither is fenced off.
        ProtectHome = lib.mkDefault false;
        NoNewPrivileges = lib.mkDefault false;
        UMask = "0077";
      };
    };
  };
}
