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

  if (!opts.allowOutput) {
    program.configureOutput({
      writeOut: () => undefined,
      writeErr: () => undefined
    });
  }

  const provider = program.command("provider").description("manage model providers and defaults");
  provider
    .command("list")
    .description("list known providers and auth status")
    .action(() => {
      parsed = { args: ["provider", "list"], options: {} };
    });
  provider
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
  provider
    .command("use")
    .description("set the default provider/model by fuzzy model id")
    .argument("<model>")
    .action((modelQuery: string) => {
      parsed = { args: ["provider", "use", modelQuery], options: {} };
    });

  const config = provider.command("config").description("show or update provider defaults");
  config.action(() => {
    parsed = { args: ["provider", "config"], options: {} };
  });
  config
    .command("set-provider")
    .argument("<provider>")
    .action((providerId: string) => {
      parsed = { args: ["provider", "config", "set-provider", providerId], options: {} };
    });
  config
    .command("set-model")
    .argument("<provider>")
    .argument("<model>")
    .action((providerId: string, modelId: string) => {
      parsed = { args: ["provider", "config", "set-model", providerId, modelId], options: {} };
    });
  config
    .command("set-depth")
    .argument("<light|normal|deep>")
    .action((depth: string) => {
      parsed = { args: ["provider", "config", "set-depth", depth], options: {} };
    });
  config
    .command("set-reasoning")
    .argument("<low|medium|high|xhigh|auto>")
    .action((reasoning: string) => {
      parsed = { args: ["provider", "config", "set-reasoning", reasoning], options: {} };
    });

  try {
    program.parse(argv, { from: "user" });
  } catch (error) {
    if (isCommanderDisplayExit(error)) {
      throw new CliDisplayExit(error.exitCode);
    }
    throw commanderToCodegenieError(error);
  }

  if (!parsed) {
    throw new CodegenieError("invalid_args", "expected provider command: list, login, logout, auth-status, models, use, or config");
  }
  return parsed;
}

function isCommanderDisplayExit(error: unknown): error is CommanderError {
  return error instanceof CommanderError && error.exitCode === 0;
}

function commanderToCodegenieError(error: unknown): CodegenieError {
  if (error instanceof CommanderError) {
    return new CodegenieError("invalid_args", error.message, {
      context: { code: error.code, exitCode: error.exitCode }
    });
  }
  if (error instanceof CodegenieError) {
    return error;
  }
  return new CodegenieError("invalid_args", "failed to parse provider command line", { cause: error });
}
