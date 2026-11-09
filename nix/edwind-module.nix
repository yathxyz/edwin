# services.edwind: edwind as a system service, the server counterpart of programs.edwin's user daemon. One
# edwind owns a notes directory and serves every client on its socket: edwin and `edwin -g` (locally or over
# ssh), Workbench's wb-web and wb, and edwin-web's front. Clients that need it order themselves after
# edwind.service; edwind needs none of them (without hubSocket, only processes are unavailable).
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
  cfg = config.services.edwind;
  userCfg = config.users.users.${cfg.user};
  home = userCfg.home;
  json = pkgs.formats.json { };

  expandHome =
    p:
    if p == "~" then
      home
    else if lib.hasPrefix "~/" p then
      home + lib.removePrefix "~" p
    else
      p;
  writable = map expandHome cfg.writablePaths;
  # R14.8: never writable, whatever writablePaths says. edit.json refuses them and the unit mounts them read-only.
  refusePaths = [
    "${home}/.ssh"
    "${home}/.config/systemd"
    "${home}/.local/share/systemd"
  ];
  # The writable parents of refusePaths, bound onto themselves: a mount point cannot be renamed, so nothing can
  # move ~/.config aside and create a fresh ~/.config/systemd that the user manager would read.
  pinnedPaths = [
    "${home}/.config"
    "${home}/.local"
    "${home}/.local/share"
  ];

  # Backends with a key file get a LoadCredential entry and name it here; the key never enters the config.
  backend =
    name: b:
    lib.filterAttrs (_: v: v != null) {
      inherit (b) baseUrl;
      credential = if b.apiKeyFile != null then "${name}-api-key" else null;
    };
  credentials =
    lib.optional (
      cfg.models.anthropic.apiKeyFile != null
    ) "anthropic-api-key:${cfg.models.anthropic.apiKeyFile}"
    ++ lib.optional (
      cfg.models.openai.apiKeyFile != null
    ) "openai-api-key:${cfg.models.openai.apiKeyFile}"
    ++ lib.mapAttrsToList (name: c: "${name}:${c.file}") cfg.credentials;

  editJson = json.generate "edwind.json" (
    {
      inherit (cfg)
        socket
        stateDir
        configDir
        notesDir
        host
        logLevel
        ;
      writablePaths = writable;
      inherit refusePaths;
      models = {
        anthropic = backend "anthropic" cfg.models.anthropic;
        openai = backend "openai" cfg.models.openai;
        tiers = cfg.models.tiers;
        credentials = lib.mapAttrs (_: c: { inherit (c) origin; }) cfg.credentials;
      };
    }
    // lib.optionalAttrs (cfg.hubSocket != null) { inherit (cfg) hubSocket; }
  );

  httpsOrLoopback =
    url:
    lib.hasPrefix "https://" url
    || lib.any (h: lib.hasPrefix h url) [
      "http://localhost"
      "http://127.0.0.1"
      "http://[::1]"
    ];
  isName = n: builtins.match "[a-z0-9-]{1,32}" n != null;
in
{
  options.services.edwind = {
    enable = mkEnableOption "edwind, Edwin's text daemon, as a system service";

    package = mkOption {
      type = types.package;
      default = self.packages.${pkgs.stdenv.hostPlatform.system}.edwind;
      defaultText = lib.literalExpression "edwin.packages.\${system}.edwind";
      description = "The edwind package.";
    };

    user = mkOption {
      type = types.str;
      description = "The user edwind runs as and writes the notes as; an existing user with a home.";
    };

    socket = mkOption {
      type = types.str;
      default = "/run/edwind/edit.sock";
      readOnly = true;
      description = "The socket edwind listens on (mode 0700 directory, the user's only). Clients read it from here.";
    };

    notesDir = mkOption {
      type = types.str;
      description = "The notes directory edwind owns.";
    };

    stateDir = mkOption {
      type = types.str;
      default = "${home}/.local/state/edwin/edwind";
      defaultText = lib.literalExpression ''"''${home}/.local/state/edwin/edwind"'';
      description = "Journals, snapshots and the image log. Losing it loses edits not yet saved to their files.";
    };

    configDir = mkOption {
      type = types.str;
      default = "${home}/.config/edwin";
      defaultText = lib.literalExpression ''"''${home}/.config/edwin"'';
      description = "Edwin's user configuration (init.scm and the like).";
    };

    host = mkOption {
      type = types.str;
      default = config.networking.hostName;
      defaultText = lib.literalExpression "config.networking.hostName";
      description = "The host name edwind reports to clients.";
    };

    logLevel = mkOption {
      type = types.enum [
        "error"
        "warn"
        "info"
        "debug"
      ];
      default = "info";
      description = "edwind's log level.";
    };

    memoryMiB = mkOption {
      type = types.ints.positive;
      default = 1024;
      description = "V8 heap limit for edwind (--max-old-space-size); MemoryMax is this plus 25%.";
    };

    writablePaths = mkOption {
      type = types.listOf types.str;
      default = [ "~" ];
      description = "Where edwind may write besides notesDir, stateDir and configDir. `~` is the user's home. ~/.ssh, ~/.config/systemd and ~/.local/share/systemd are never writable.";
    };

    readOnlyPaths = mkOption {
      type = types.listOf types.str;
      default = [ ];
      description = "More paths mounted read-only for edwind (a leading - ignores a missing one), such as another program's state under the home.";
    };

    hubSocket = mkOption {
      type = types.nullOr types.str;
      default = null;
      description = "A Workbench hub socket for processes (PTY sessions). Without it edwind runs, and processes report the hub unconfigured.";
    };

    models = {
      anthropic = {
        apiKeyFile = mkOption {
          type = types.nullOr types.path;
          default = null;
          description = "Root-readable Anthropic key file, loaded as the credential anthropic-api-key.";
        };
        baseUrl = mkOption {
          type = types.str;
          default = "https://api.anthropic.com";
          description = "https, or http to loopback; the credential is bound to this origin.";
        };
      };
      openai = {
        apiKeyFile = mkOption {
          type = types.nullOr types.path;
          default = null;
          description = "Root-readable key file for an OpenAI-compatible backend, loaded as openai-api-key.";
        };
        baseUrl = mkOption {
          type = types.nullOr types.str;
          default = null;
          description = "Base URL of the OpenAI-compatible backend; https, or http to loopback.";
        };
      };
      tiers = mkOption {
        type = types.attrsOf types.str;
        default = {
          default = "claude-opus-5-5";
          quick = "claude-haiku-5-5";
        };
        description = "Model names by tier (R12.6).";
      };
    };

    credentials = mkOption {
      default = { };
      description = "More LoadCredential entries, readable from Scheme only as (credential \"name\") handles bound to origin.";
      type = types.attrsOf (
        types.submodule {
          options = {
            file = mkOption {
              type = types.path;
              description = "Root-readable secret file.";
            };
            origin = mkOption {
              type = types.str;
              description = "The only origin (scheme://host[:port]) http-request may send this credential to.";
            };
          };
        }
      );
    };
  };

  config = mkIf cfg.enable {
    assertions = [
      {
        assertion = lib.all (p: p == "~" || lib.hasPrefix "~/" p || lib.hasPrefix "/" p) cfg.writablePaths;
        message = "services.edwind.writablePaths: entries must be absolute or start with ~.";
      }
      {
        assertion =
          httpsOrLoopback cfg.models.anthropic.baseUrl
          && (cfg.models.openai.baseUrl == null || httpsOrLoopback cfg.models.openai.baseUrl)
          && lib.all (c: httpsOrLoopback c.origin) (lib.attrValues cfg.credentials);
        message = "services.edwind.models.*.baseUrl and credentials.*.origin must be https, or http to loopback.";
      }
      {
        assertion = lib.all isName (lib.attrNames cfg.credentials);
        message = "services.edwind.credentials: names must match ^[a-z0-9-]{1,32}$.";
      }
    ];

    environment.etc."edwind/edit.json".source = editJson;

    # The state and config directories exist before the unit starts (R14.10); the parents are the user's, left
    # as they are when present.
    systemd.tmpfiles.rules =
      map (d: "d ${d} - ${cfg.user} ${userCfg.group} -") (pinnedPaths ++ [ "${home}/.local/state" ])
      ++ map (d: "d ${d} 0700 ${cfg.user} ${userCfg.group} -") (
        refusePaths
        ++ [
          cfg.stateDir
          cfg.configDir
        ]
      );

    # R14.10, R14.11, R15.3. It restarts on its own at a deploy; clients reconnect (R15.8). Edits and the image
    # log are on disk before they are acknowledged, so a restart loses nothing.
    systemd.services.edwind = {
      description = "edwind, Edwin's text daemon";
      wantedBy = [ "multi-user.target" ];
      stopIfChanged = false;
      restartTriggers = [ editJson ];
      startLimitIntervalSec = 0;
      environment.EDWIND_MEMORY_MIB = toString cfg.memoryMiB;
      serviceConfig = {
        Type = "exec";
        ExecStart = "${cfg.package}/bin/edwind --config /etc/edwind/edit.json";
        User = cfg.user;
        Group = userCfg.group;
        UMask = "0077";
        RuntimeDirectory = "edwind";
        RuntimeDirectoryMode = "0700";
        # edwind is TypeScript that Node strips at load; the compile cache keeps the stripped code, so only the
        # first start after a deploy pays for it.
        CacheDirectory = "edwind";
        CacheDirectoryMode = "0700";
        Environment = [ "NODE_COMPILE_CACHE=%C/edwind" ];
        LoadCredential = credentials;
        Restart = "always";
        RestartSec = 1;
        TimeoutStopSec = 10;
        OOMScoreAdjust = 100;
        MemoryMax = "${toString (cfg.memoryMiB * 5 / 4)}M";
        # The server runs on a worker thread whose stack main.mts sizes itself (32 MiB); the limit only has to
        # admit that thread's stack.
        LimitSTACK = "64M";

        NoNewPrivileges = true;
        PrivateTmp = true;
        PrivateDevices = true;
        ProtectSystem = "strict";
        # The home plus writable paths outside it; the more specific mounts below win inside the home.
        ReadWritePaths = lib.unique (
          [
            home
            cfg.notesDir
            cfg.stateDir
            cfg.configDir
          ]
          ++ lib.filter (p: !(lib.hasPrefix "${home}/" p) && p != home) writable
        );
        ReadOnlyPaths = refusePaths ++ cfg.readOnlyPaths;
        BindPaths = pinnedPaths;
        InaccessiblePaths = [ "-/run/user" ];
        RestrictAddressFamilies = [
          "AF_UNIX"
          "AF_INET"
          "AF_INET6"
        ];
        LockPersonality = true;
        RestrictRealtime = true;
        RestrictNamespaces = true;
        RestrictSUIDSGID = true;
        SystemCallArchitectures = "native";
        ProtectClock = true;
        ProtectHostname = true;
        ProtectKernelTunables = true;
        ProtectKernelModules = true;
        ProtectKernelLogs = true;
        ProtectControlGroups = true;
        CapabilityBoundingSet = "";
        # No MemoryDenyWriteExecute: V8's JIT needs it.
      };
    };
  };
}
