# A module in alejandra's layout, for the indent rules' fixture (test/fixtures/syntax-indent).
{
  config,
  lib,
  pkgs,
  extraArgs ? {
    enable = false;
    names = ["one" "two"];
  },
  ...
} @ args:
with lib; let
  cfg = config.services.example;
  inherit (lib) mkIf mkOption types concatStringsSep mapAttrs' nameValuePair optionals optionalString listToAttrs attrNames;
  /*
  A block comment,
    kept as it is.
  */
  ports = map (n: n + 8000) (lib.range 1 cfg.instances);
  pick = name: value:
    if cfg.verbose && name != "default" && value.enable
    then "${name}-verbose"
    else name;
  script = pkgs.writeShellScript "example" ''
    set -eu
      echo "${cfg.greeting}"
    ${lib.concatMapStrings (p: ''
        echo port ${toString p}
      '')
      ports}
    exec ${pkgs.hello}/bin/hello
  '';
  units = listToAttrs (map (name: {
    name = "example-${name}";
    value = {
      wantedBy = ["multi-user.target"];
      serviceConfig.ExecStart = "${script} ${name}";
    };
  }) (attrNames cfg.users));
  flags = concatStringsSep " " (["--quiet" "--port" (toString cfg.port)]
    ++ optionals cfg.verbose ["--verbose" "--log-level" "debug"]
    ++ cfg.extraFlags);
  inherit
    (cfg)
    port
    greeting
    ;
  replacedTwo =
    builtins.replaceStrings
    ["@greeting@" "@port@"]
    [cfg.greeting (toString cfg.port)]
    (builtins.readFile ./example.conf);
  depsOf = pkg: (pkg.propagatedBuildInputs or []);
  wrapped = x:
  # Comments between a lambda's `:` and its body, at the binding's level,
    x + 1;
  extended = overlay: f:
  # and the body after them when alejandra would begin it on the `:` line.
  let
    prev = f;
  in
    prev // overlay;
  mapped = map (x:
    # In a parenthesis, a level in.
      x.name)
  cfg.users;
  curried = lib.mapAttrs (name: value:
    # A curried lambda's too.
    {inherit name value;})
  cfg.users;
  settings =
    lib.recursiveUpdate
    {
      a = 1;
      b = 2;
    }
    {c = 3;};
  paths =
    [
      "./a"
      "./b"
    ]
    ++ cfg.extraPaths;
  apply = (x:
    x + 1)
  2;
  checkedTwo = assert cfg.port > 0;
  assert cfg.instances > 0;
  with cfg; port;
  replaced = builtins.replaceStrings ["@greeting@" "@port@"] [cfg.greeting (toString cfg.port)] (builtins.readFile ./example.conf);
  home =
    cfg.users.${cfg.mainUser}.home
      or (throw "services.example.mainUser ${cfg.mainUser} has no home directory");
  first =
    {
      a = {
        b = 1;
        c = 2;
        d = 3;
        e = 4;
        f = 5;
        g = 6;
        h = 7;
        i = 8;
        j = 9;
        k = 10;
        l = 11;
        m = 12;
      };
    }.a;
  merged =
    cfg.settings
    // {
      port = cfg.port;
      greeting = cfg.greeting;
    }
    // optionalAttrs cfg.verbose {level = "debug";};
  checked = assert cfg.port > 0 && cfg.port < 65536 && cfg.instances > 0 && cfg.greeting != "" && cfg.mainUser != ""; cfg.port;
  nested = let
    inner = 1;
    other = 2;
  in
    inner + other;
  lambda = {
    name,
    value ? null,
    ...
  }: {
    inherit name;
    value =
      if value == null
      then "none"
      else toString value;
  };
in {
  options.services.example = {
    enable = mkOption {
      type = types.bool;
      default = false;
      description = "Whether to run the example service.";
    };
    users = mkOption {
      type = types.attrsOf (types.submodule {options.home = mkOption {type = types.str;};});
      default = {};
    };
  };
  config = mkIf cfg.enable {
    systemd.services =
      units
      // {
        example-main = {
          after = ["network.target"];
          script = "exec ${script} --main ${flags}";
        };
      };
    environment.etc."example.conf".text = replaced;
    assertions = [
      {
        assertion = cfg.instances <= 16;
        message = "services.example.instances is at most 16";
      }
    ];
    users.users = mapAttrs' (name: user:
      nameValuePair "example-${name}" {
        isSystemUser = true;
        group = "example";
        home = user.home;
      })
    cfg.users;
    networking.firewall.allowedTCPPorts =
      if cfg.openFirewall
      then ports
      else if cfg.verbose
      then [cfg.port]
      else [];
  };
}
