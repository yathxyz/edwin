# programs.edwin: Edwin on a NixOS desktop, as services.emacs is for Emacs. The edwin package on the path, and
# optionally edwind as a systemd user service (edwin --fg-daemon), so every edwinclient and `edwinclient -c` the
# user starts is a frame of the same buffers, and EDITOR=edwin. The service is active only once its socket answers
# (ExecStartPost=edwin-daemon --wait), so a unit ordered After= it can connect at once. daemon.settings is merged
# into the edwind.json the daemon writes at each start (models, brain, hub), and daemon.credentials are the unit's
# LoadCredential entries those settings name: the secrets stay in their files, never in the store.
self:
{
  config,
  lib,
  pkgs,
  ...
}:
let
  inherit (lib)
    mkEnableOption
    mkIf
    mkOption
    types
    ;
  cfg = config.programs.edwin;
  json = pkgs.formats.json { };
  # The settings with every credential's file added to the refusals: edwind loads a credential from
  # $CREDENTIALS_DIRECTORY, and no form or frame may read the file it was loaded from either.
  extra =
    cfg.daemon.settings
    // lib.optionalAttrs (cfg.daemon.credentials != { }) {
      refusePaths = (cfg.daemon.settings.refusePaths or [ ]) ++ lib.attrValues cfg.daemon.credentials;
    };
  # The fields edwin-daemon makes itself; a fragment that set them would part the daemon from its socket.
  ownFields = [
    "socket"
    "notesDir"
    "stateDir"
    "configDir"
  ];
in
{
  options.programs.edwin = {
    enable = mkEnableOption "Edwin on the desktop (edwin, edwin -g, edwin --daemon, edwinclient)";
    package = mkOption {
      type = types.package;
      default = self.packages.${pkgs.stdenv.hostPlatform.system}.edwin;
      defaultText = lib.literalExpression "edwin.packages.\${system}.edwin";
      description = "The edwin package.";
    };
    daemon = {
      enable = mkEnableOption "edwind as a systemd user service for every user, on $XDG_RUNTIME_DIR/edwin/edit.sock";
      notesDir = mkOption {
        type = types.str;
        default = "%h/notes";
        description = "The notes directory edwind serves (EDWIN_NOTES_DIR); %h is the user's home.";
      };
      memoryMiB = mkOption {
        type = types.ints.positive;
        default = 1024;
        description = "V8 heap limit for edwind (--max-old-space-size).";
      };
      settings = mkOption {
        inherit (json) type;
        default = { };
        example = {
          models.anthropic.credential = "anthropic-api-key";
          brain = {
            url = "https://brain.example";
            readCredential = "brain-read-token";
          };
        };
        description = ''
          Fields of edwind.json (server/main.mts loadConfig) beside the ones edwin-daemon writes, merged from every
          module that sets them, in the store as EDWIND_CONFIG_EXTRA: refusePaths are added to the daemon's own,
          any other field is taken as given; ${lib.concatStringsSep ", " ownFields} are the daemon's. Credentials
          are named here, never written: the store is world-readable.
        '';
      };
      credentials = mkOption {
        type = types.attrsOf types.str;
        default = { };
        example = {
          anthropic-api-key = "/run/secrets/anthropic";
        };
        description = ''
          LoadCredential entries of the user unit, name to file: edwind reads $CREDENTIALS_DIRECTORY/NAME when
          settings names NAME. The file must be readable by the user (a sops secret with owner set to them) and
          outside the store; the name matches ^[a-z0-9-]{1,32}$. Each file is added to edwind's refusePaths, so
          no form or frame reads it.
        '';
      };
    };
    defaultEditor = mkOption {
      type = types.bool;
      default = false;
      description = "Set EDITOR and VISUAL to edwin (the editor on its own, in the terminal, which never waits on a daemon).";
    };
  };

  config = mkIf cfg.enable {
    assertions = [
      {
        assertion = lib.all (n: builtins.match "[a-z0-9-]{1,32}" n != null) (lib.attrNames cfg.daemon.credentials);
        message = "programs.edwin.daemon.credentials: names must match ^[a-z0-9-]{1,32}$.";
      }
      {
        # A file in the store is readable by every user of the machine; a colon would end LoadCredential's path.
        assertion = lib.all (
          f: lib.hasPrefix "/" f && !lib.hasPrefix "${builtins.storeDir}/" f && !lib.hasInfix ":" f
        ) (lib.attrValues cfg.daemon.credentials);
        message = "programs.edwin.daemon.credentials: each file must be an absolute path outside ${builtins.storeDir}, with no colon.";
      }
      {
        assertion = !lib.any (k: cfg.daemon.settings ? ${k}) ownFields;
        message = "programs.edwin.daemon.settings: ${lib.concatStringsSep ", " ownFields} are edwin-daemon's own.";
      }
    ];
    environment.systemPackages = [ cfg.package ];
    environment.variables = mkIf cfg.defaultEditor {
      EDITOR = lib.mkOverride 900 "edwin";
      VISUAL = lib.mkOverride 900 "edwin";
    };
    systemd.user.services.edwind = mkIf cfg.daemon.enable {
      description = "edwind, Edwin's text daemon";
      wantedBy = [ "default.target" ];
      environment = {
        EDWIN_NOTES_DIR = cfg.daemon.notesDir;
        EDWIND_MEMORY_MIB = toString cfg.daemon.memoryMiB;
      }
      // lib.optionalAttrs (extra != { }) {
        EDWIND_CONFIG_EXTRA = toString (json.generate "edwind-extra.json" extra);
      };
      serviceConfig = {
        Type = "exec";
        ExecStart = "${cfg.package}/bin/edwin --fg-daemon";
        # Started is not listening: 'active' waits until the socket accepts (at most 30 s, else the start fails;
        # at once when the main process, systemd's $MAINPID, has exited, so a crashing edwind meets the start limit).
        ExecStartPost = "${cfg.package}/bin/edwin-daemon --wait";
        Restart = "on-failure";
        # 3: another start (a manual `edwin --daemon`) started the edwind on the socket meanwhile; no retry.
        RestartPreventExitStatus = 3;
        RestartSec = 1;
        UMask = "0077";
        # The server's worker thread sizes its own stack (32 MiB) for the Scheme cap.
        LimitSTACK = "64M";
      }
      // lib.optionalAttrs (cfg.daemon.credentials != { }) {
        LoadCredential = lib.mapAttrsToList (n: f: "${n}:${f}") cfg.daemon.credentials;
      };
    };
  };
}
