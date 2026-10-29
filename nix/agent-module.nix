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
        The server's agent endpoint. It must be `wss://`, since the token and repository
        passphrases travel over it; `ws://` is only accepted to this machine.
      '';
    };

    tokenFile = mkOption {
      type = types.str;
      example = "/run/secrets/x-backups-agent-token";
      description = "File holding the token the server issued when this host was enrolled.";
    };

    user = mkOption {
      type = types.str;
      default = "root";
      description = "User the agent and the backups it runs as; borg must be able to read every source.";
    };
  };

  config = mkIf cfg.enable {
    systemd.services.x-backups-agent = {
      description = "X-Backups agent";
      wantedBy = [ "multi-user.target" ];
      wants = [ "network-online.target" ];
      after = [ "network-online.target" ];

      path = [
        pkgs.bash
        pkgs.openssh
        pkgs.borgbackup
        packages.borg2
      ];

      environment = {
        X_BACKUPS_AGENT_URL = cfg.url;
        X_BACKUPS_AGENT_TOKEN_FILE = "/run/credentials/x-backups-agent.service/token";
        X_BACKUPS_AGENT_STATE_DIR = "/var/lib/x-backups-agent";
      };

      serviceConfig = {
        ExecStart = lib.getExe cfg.package;
        User = cfg.user;
        StateDirectory = "x-backups-agent";
        StateDirectoryMode = "0700";
        LoadCredential = [ "token:${cfg.tokenFile}" ];
        Restart = "always";
        RestartSec = "5s";
        # A restart stops only the agent, so a backup it started keeps going and is picked up again.
        KillMode = "process";
        UMask = "0077";
      };
    };
  };
}
