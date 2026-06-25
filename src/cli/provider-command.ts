import { Command, CommanderError } from "commander";
import { runProviderCommand, type RunProviderCommandOptions } from "../provider/provider-services.js";
import { CodegenieError } from "../util/errors.js";
import { CliDisplayExit } from "./review-command.js";

type ParseProviderCommandOptions = {
  allowOutput?: boolean;
};

type ParsedProviderCommand = {
  args: string[];
  options: Pick<RunProviderCommandOptions, "yes" | "all" | "apiKeyLogin">;
};

export async function executeProviderCommand(
  argv: string[],
  opts: RunProviderCommandOptions & ParseProviderCommandOptions = {}
): Promise<void> {
  const parsed = parseProviderCommand(argv, opts);
  await runProviderCommand(parsed.args, { ...opts, ...parsed.options });
}

export function parseProviderCommand(
  argv: string[],
  opts: ParseProviderCommandOptions = {}
): ParsedProviderCommand {
  let parsed: ParsedProviderCommand | undefined;
  const program = new Command();
  program.name("codegenie").exitOverride();

  program.configureOutput({
    writeOut: opts.allowOutput ? (text) => process.stdout.write(text) : () => undefined,
    writeErr: () => undefined
  });

  const provider = program.command("provider").description("manage model providers and defaults");
  const helpByPath = new Map<string, Command>();
  provider
    .command("list")
    .description("list known providers and auth status")
    .action(() => {
      parsed = { args: ["provider", "list"], options: {} };
    });
  const loginCommand = provider
    .command("login")
    .description("store credentials for a provider")
    .argument("<provider>")
    .option("--api-key", "store an API key instead of using OAuth")
    .action((providerId: string, options: { apiKey?: boolean }) => {
      parsed = {
        args: ["provider", "login", providerId],
        options: { apiKeyLogin: options.apiKey === true }
      };
    });
  helpByPath.set("provider login", loginCommand);
  provider
    .command("logout")
    .description("remove one provider credential, or all credentials with --yes")
    .argument("[provider]")
    .option("--yes", "confirm removing all credentials")
    .action((providerId: string | undefined, options: { yes?: boolean }) => {
      parsed = {
        args: providerId ? ["provider", "logout", providerId] : ["provider", "logout"],
        options: { yes: options.yes === true }
      };
    });
  provider
    .command("auth-status")
    .description("show stored or environment auth status")
    .argument("[provider]")
    .action((providerId: string | undefined) => {
      parsed = {
        args: providerId ? ["provider", "auth-status", providerId] : ["provider", "auth-status"],
        options: {}
      };
    });
  provider
    .command("models")
    .description("list available models")
    .argument("[query]")
    .option("--all", "include unauthenticated providers")
    .action((query: string | undefined, options: { all?: boolean }) => {
      parsed = {
        args: query ? ["provider", "models", query] : ["provider", "models"],
        options: { all: options.all === true }
      };
    });
  const useCommand = provider
    .command("use")
    .description("set the default provider/model by fuzzy model id")
    .argument("<model>")
    .action((modelQuery: string) => {
      parsed = { args: ["provider", "use", modelQuery], options: {} };
    });
  helpByPath.set("provider use", useCommand);

  const config = provider.command("config").description("show or update provider defaults");
  config.action(() => {
    parsed = { args: ["provider", "config"], options: {} };
  });
  const configSetProviderCommand = config
    .command("set-provider")
    .argument("<provider>")
    .action((providerId: string) => {
      parsed = { args: ["provider", "config", "set-provider", providerId], options: {} };
    });
  helpByPath.set("provider config set-provider", configSetProviderCommand);
  const configSetModelCommand = config
    .command("set-model")
    .argument("<provider>")
    .argument("<model>")
    .action((providerId: string, modelId: string) => {
      parsed = { args: ["provider", "config", "set-model", providerId, modelId], options: {} };
    });
  helpByPath.set("provider config set-model", configSetModelCommand);
  const configSetDepthCommand = config
    .command("set-depth")
    .argument("<light|normal|deep>")
    .action((depth: string) => {
      parsed = { args: ["provider", "config", "set-depth", depth], options: {} };
    });
  helpByPath.set("provider config set-depth", configSetDepthCommand);
  const configSetReasoningCommand = config
    .command("set-reasoning")
    .argument("<low|medium|high|xhigh|auto>")
    .action((reasoning: string) => {
      parsed = { args: ["provider", "config", "set-reasoning", reasoning], options: {} };
    });
  helpByPath.set("provider config set-reasoning", configSetReasoningCommand);

  try {
    program.parse(argv, { from: "user" });
  } catch (error) {
    if (isCommanderDisplayExit(error)) {
      throw new CliDisplayExit(error.exitCode);
    }
    throw commanderToCodegenieError(error, argv, helpByPath);
  }

  if (!parsed) {
    throw new CodegenieError("invalid_args", "expected provider command: list, login, logout, auth-status, models, use, or config");
  }
  return parsed;
}

function isCommanderDisplayExit(error: unknown): error is CommanderError {
  return error instanceof CommanderError && error.exitCode === 0;
}

function commanderToCodegenieError(
  error: unknown,
  argv: string[],
  helpByPath: Map<string, Command>
): CodegenieError {
  if (error instanceof CommanderError) {
    const commandPath = commandPathForArgv(argv);
    const helpText = error.code === "commander.missingArgument" ? helpByPath.get(commandPath)?.helpInformation() : undefined;
    const hint = commandPath === "provider login"
      ? "⭐ 🧞 Please run `codegenie provider list` to get a list of LLM providers."
      : undefined;
    return new CodegenieError("invalid_args", error.message, {
      context: {
        code: error.code,
        exitCode: error.exitCode,
        ...(helpText !== undefined ? { helpText } : {}),
        ...(hint !== undefined ? { hint } : {})
      }
    });
  }
  if (error instanceof CodegenieError) {
    return error;
  }
  return new CodegenieError("invalid_args", "failed to parse provider command line", { cause: error });
}

function commandPathForArgv(argv: string[]): string {
  if (argv[0] === "help") {
    return argv.slice(1, 4).join(" ");
  }
  if (argv[0] === "provider" && argv[1] === "config") {
    return argv.slice(0, 3).join(" ");
  }
  return argv.slice(0, 2).join(" ");
}
