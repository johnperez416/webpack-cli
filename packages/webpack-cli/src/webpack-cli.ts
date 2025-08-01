import { type stringifyChunked } from "@discoveryjs/json-ext";
import { type Help, type ParseOptions } from "commander";
import {
  type Compiler,
  type MultiCompiler,
  type MultiStatsOptions,
  type StatsOptions,
  type WebpackError,
  default as webpack,
} from "webpack";
import type webpackMerge from "webpack-merge";

import { type CLIPlugin as CLIPluginClass } from "./plugins/cli-plugin.js";
import {
  type Argument,
  type Argv,
  type BasicPrimitive,
  type CLIPluginOptions,
  type CallableWebpackConfiguration,
  type CommandAction,
  type DynamicImport,
  type EnumValue,
  type FileSystemCacheOptions,
  type IWebpackCLI,
  type ImportLoaderError,
  type Instantiable,
  type JsonExt,
  type LoadableWebpackConfiguration,
  type ModuleName,
  type PackageInstallOptions,
  type PackageManager,
  type Path,
  type PotentialPromise,
  type Problem,
  type ProcessedArguments,
  type PromptOptions,
  type Rechoir,
  type RechoirError,
  type StringsKeys,
  type WebpackCLIBuiltInFlag,
  type WebpackCLIBuiltInOption,
  type WebpackCLIColors,
  type WebpackCLICommand,
  type WebpackCLICommandOption,
  type WebpackCLICommandOptions,
  type WebpackCLIConfig,
  type WebpackCLIExternalCommandInfo,
  type WebpackCLILogger,
  type WebpackCLIMainOption,
  type WebpackCLIOptions,
  type WebpackCallback,
  type WebpackCompiler,
  type WebpackConfiguration,
  type WebpackDevServerOptions,
  type WebpackRunOptions,
} from "./types.js";

const fs = require("node:fs");
const path = require("node:path");
const { Readable } = require("node:stream");
const { pathToFileURL } = require("node:url");
const util = require("node:util");
const { Option, program } = require("commander");

const WEBPACK_PACKAGE_IS_CUSTOM = Boolean(process.env.WEBPACK_PACKAGE);
const WEBPACK_PACKAGE = WEBPACK_PACKAGE_IS_CUSTOM
  ? (process.env.WEBPACK_PACKAGE as string)
  : "webpack";
const WEBPACK_DEV_SERVER_PACKAGE_IS_CUSTOM = Boolean(process.env.WEBPACK_DEV_SERVER_PACKAGE);
const WEBPACK_DEV_SERVER_PACKAGE = WEBPACK_DEV_SERVER_PACKAGE_IS_CUSTOM
  ? (process.env.WEBPACK_DEV_SERVER_PACKAGE as string)
  : "webpack-dev-server";

const EXIT_SIGNALS = ["SIGINT", "SIGTERM"];

interface Information {
  Binaries?: string[];
  Browsers?: string[];
  Monorepos?: string[];
  System?: string[];
  npmGlobalPackages?: string[];
  npmPackages?: string | string[];
}

class WebpackCLI implements IWebpackCLI {
  colors: WebpackCLIColors;

  logger: WebpackCLILogger;

  isColorSupportChanged: boolean | undefined;

  builtInOptionsCache: WebpackCLIBuiltInOption[] | undefined;

  webpack!: typeof webpack;

  program: WebpackCLICommand;

  constructor() {
    this.colors = this.createColors();
    this.logger = this.getLogger();

    // Initialize program
    this.program = program;
    this.program.name("webpack");
    this.program.configureOutput({
      writeErr: (str) => {
        this.logger.error(str);
      },
      outputError: (str, write) => {
        write(`Error: ${this.capitalizeFirstLetter(str.replace(/^error:/, "").trim())}`);
      },
    });
  }

  isMultipleCompiler(compiler: WebpackCompiler): compiler is MultiCompiler {
    return (compiler as MultiCompiler).compilers as unknown as boolean;
  }

  isPromise<T>(value: Promise<T>): value is Promise<T> {
    return typeof (value as unknown as Promise<T>).then === "function";
  }

  isFunction(value: unknown): value is CallableFunction {
    return typeof value === "function";
  }

  capitalizeFirstLetter(str: string | unknown): string {
    if (typeof str !== "string") {
      return "";
    }

    return str.charAt(0).toUpperCase() + str.slice(1);
  }

  toKebabCase(str: string): string {
    return str.replaceAll(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
  }

  createColors(useColor?: boolean): WebpackCLIColors {
    try {
      const { cli } = require("webpack");

      if (typeof cli.createColors === "function") {
        const { createColors, isColorSupported } = cli;
        const shouldUseColor = useColor || isColorSupported();

        return { ...createColors({ useColor: shouldUseColor }), isColorSupported: shouldUseColor };
      }
    } catch {
      // Nothing
    }

    // TODO remove `colorette` and set webpack@5.101.0 as the minimum supported version in the next major release
    const { createColors, isColorSupported } = require("colorette");

    const shouldUseColor = useColor || isColorSupported;

    return { ...createColors({ useColor: shouldUseColor }), isColorSupported: shouldUseColor };
  }

  getLogger(): WebpackCLILogger {
    return {
      error: (val) => console.error(`[webpack-cli] ${this.colors.red(util.format(val))}`),
      warn: (val) => console.warn(`[webpack-cli] ${this.colors.yellow(val)}`),
      info: (val) => console.info(`[webpack-cli] ${this.colors.cyan(val)}`),
      success: (val) => console.log(`[webpack-cli] ${this.colors.green(val)}`),
      log: (val) => console.log(`[webpack-cli] ${val}`),
      raw: (val) => console.log(val),
    };
  }

  checkPackageExists(packageName: string): boolean {
    if (process.versions.pnp) {
      return true;
    }

    let dir = __dirname;

    do {
      try {
        if (fs.statSync(path.join(dir, "node_modules", packageName)).isDirectory()) {
          return true;
        }
      } catch {
        // Nothing
      }
    } while (dir !== (dir = path.dirname(dir)));

    // https://github.com/nodejs/node/blob/v18.9.1/lib/internal/modules/cjs/loader.js#L1274
    for (const internalPath of require("node:module").globalPaths) {
      try {
        if (fs.statSync(path.join(internalPath, packageName)).isDirectory()) {
          return true;
        }
      } catch {
        // Nothing
      }
    }

    return false;
  }

  getAvailablePackageManagers(): PackageManager[] {
    const { sync } = require("cross-spawn");

    const installers: PackageManager[] = ["npm", "yarn", "pnpm"];
    const hasPackageManagerInstalled = (packageManager: PackageManager) => {
      try {
        sync(packageManager, ["--version"]);

        return packageManager;
      } catch {
        return false;
      }
    };
    const availableInstallers = installers.filter((installer) =>
      hasPackageManagerInstalled(installer),
    );

    if (!availableInstallers.length) {
      this.logger.error("No package manager found.");

      process.exit(2);
    }

    return availableInstallers;
  }

  getDefaultPackageManager(): PackageManager | undefined {
    const { sync } = require("cross-spawn");

    const hasLocalNpm = fs.existsSync(path.resolve(process.cwd(), "package-lock.json"));

    if (hasLocalNpm) {
      return "npm";
    }

    const hasLocalYarn = fs.existsSync(path.resolve(process.cwd(), "yarn.lock"));

    if (hasLocalYarn) {
      return "yarn";
    }

    const hasLocalPnpm = fs.existsSync(path.resolve(process.cwd(), "pnpm-lock.yaml"));

    if (hasLocalPnpm) {
      return "pnpm";
    }

    try {
      // the sync function below will fail if npm is not installed,
      // an error will be thrown
      if (sync("npm", ["--version"])) {
        return "npm";
      }
    } catch {
      // Nothing
    }

    try {
      // the sync function below will fail if yarn is not installed,
      // an error will be thrown
      if (sync("yarn", ["--version"])) {
        return "yarn";
      }
    } catch {
      // Nothing
    }

    try {
      // the sync function below will fail if pnpm is not installed,
      // an error will be thrown
      if (sync("pnpm", ["--version"])) {
        return "pnpm";
      }
    } catch {
      this.logger.error("No package manager found.");

      process.exit(2);
    }
  }

  async doInstall(packageName: string, options: PackageInstallOptions = {}): Promise<string> {
    const packageManager = this.getDefaultPackageManager();

    if (!packageManager) {
      this.logger.error("Can't find package manager");

      process.exit(2);
    }

    if (options.preMessage) {
      options.preMessage();
    }

    const prompt = ({ message, defaultResponse, stream }: PromptOptions) => {
      const readline = require("node:readline");

      const rl = readline.createInterface({
        input: process.stdin,
        output: stream,
      });

      return new Promise((resolve) => {
        rl.question(`${message} `, (answer: string) => {
          // Close the stream
          rl.close();

          const response = (answer || defaultResponse).toLowerCase();

          // Resolve with the input response
          if (response === "y" || response === "yes") {
            resolve(true);
          } else {
            resolve(false);
          }
        });
      });
    };

    // yarn uses 'add' command, rest npm and pnpm both use 'install'
    const commandArguments = [packageManager === "yarn" ? "add" : "install", "-D", packageName];
    const commandToBeRun = `${packageManager} ${commandArguments.join(" ")}`;

    let needInstall;

    try {
      needInstall = await prompt({
        message: `[webpack-cli] Would you like to install '${this.colors.green(
          packageName,
        )}' package? (That will run '${this.colors.green(commandToBeRun)}') (${this.colors.yellow(
          "Y/n",
        )})`,
        defaultResponse: "Y",
        stream: process.stderr,
      });
    } catch (error) {
      this.logger.error(error);

      process.exit(error as number);
    }

    if (needInstall) {
      const { sync } = require("cross-spawn");

      try {
        sync(packageManager, commandArguments, { stdio: "inherit" });
      } catch (error) {
        this.logger.error(error);

        process.exit(2);
      }

      return packageName;
    }

    process.exit(2);
  }

  async tryRequireThenImport<T>(
    module: ModuleName,
    handleError = true,
    moduleType: "unknown" | "commonjs" | "esm" = "unknown",
  ): Promise<T> {
    let result;

    switch (moduleType) {
      case "unknown": {
        try {
          result = require(module);
        } catch (error) {
          const dynamicImportLoader: null | DynamicImport<T> =
            require("./utils/dynamic-import-loader")();

          if (
            ((error as ImportLoaderError).code === "ERR_REQUIRE_ESM" ||
              (error as ImportLoaderError).code === "ERR_REQUIRE_ASYNC_MODULE" ||
              process.env.WEBPACK_CLI_FORCE_LOAD_ESM_CONFIG) &&
            pathToFileURL &&
            dynamicImportLoader
          ) {
            const urlForConfig = pathToFileURL(module);

            result = await dynamicImportLoader(urlForConfig);
            result = result.default;

            return result;
          }

          if (handleError) {
            this.logger.error(error);
            process.exit(2);
          } else {
            throw error;
          }
        }
        break;
      }
      case "commonjs": {
        try {
          result = require(module);
        } catch (error) {
          if (handleError) {
            this.logger.error(error);
            process.exit(2);
          } else {
            throw error;
          }
        }
        break;
      }
      case "esm": {
        try {
          const dynamicImportLoader: null | DynamicImport<T> =
            require("./utils/dynamic-import-loader")();

          if (pathToFileURL && dynamicImportLoader) {
            const urlForConfig = pathToFileURL(module);

            result = await dynamicImportLoader(urlForConfig);
            result = result.default;

            return result;
          }
        } catch (error) {
          if (handleError) {
            this.logger.error(error);
            process.exit(2);
          } else {
            throw error;
          }
        }

        break;
      }
    }

    // For babel and other, only commonjs
    if (result && typeof result === "object" && "default" in result) {
      result = result.default || {};
    }

    return result || {};
  }

  loadJSONFile<T = unknown>(pathToFile: Path, handleError = true): T {
    let result;

    try {
      result = require(pathToFile);
    } catch (error) {
      if (handleError) {
        this.logger.error(error);
        process.exit(2);
      } else {
        throw error;
      }
    }

    return result;
  }

  getInfoOptions(): WebpackCLIBuiltInOption[] {
    return [
      {
        name: "output",
        alias: "o",
        configs: [
          {
            type: "string",
          },
        ],
        description: "To get the output in a specified format ( accept json or markdown )",
        helpLevel: "minimum",
      },
      {
        name: "additional-package",
        alias: "a",
        configs: [{ type: "string" }],
        multiple: true,
        description: "Adds additional packages to the output",
        helpLevel: "minimum",
      },
    ];
  }

  async getInfoOutput(options: { output: string; additionalPackage: string[] }): Promise<string> {
    let { output } = options;
    const envinfoConfig: Record<string, boolean> = {};

    if (output) {
      // Remove quotes if exist
      output = output.replaceAll(/['"]+/g, "");

      switch (output) {
        case "markdown":
          envinfoConfig.markdown = true;
          break;
        case "json":
          envinfoConfig.json = true;
          break;
        default:
          this.logger.error(`'${output}' is not a valid value for output`);
          process.exit(2);
      }
    }

    const defaultInformation: Information = {
      Binaries: ["Node", "Yarn", "npm", "pnpm"],
      Browsers: [
        "Brave Browser",
        "Chrome",
        "Chrome Canary",
        "Edge",
        "Firefox",
        "Firefox Developer Edition",
        "Firefox Nightly",
        "Internet Explorer",
        "Safari",
        "Safari Technology Preview",
      ],
      Monorepos: ["Yarn Workspaces", "Lerna"],
      System: ["OS", "CPU", "Memory"],
      npmGlobalPackages: ["webpack", "webpack-cli", "webpack-dev-server"],
    };

    let defaultPackages: string[] = ["webpack", "loader", "@webpack-cli/"];

    if (typeof options.additionalPackage !== "undefined") {
      defaultPackages = [...defaultPackages, ...options.additionalPackage];
    }

    defaultInformation.npmPackages = `{${defaultPackages.map((item) => `*${item}*`).join(",")}}`;

    const envinfo = await this.tryRequireThenImport<typeof import("envinfo")>("envinfo", false);

    let info = await envinfo.run(defaultInformation, envinfoConfig);

    info = info.replace("npmPackages", "Packages");
    info = info.replace("npmGlobalPackages", "Global Packages");

    return info;
  }

  async makeCommand(
    commandOptions: WebpackCLIOptions,
    options: WebpackCLICommandOptions,
    action: CommandAction,
  ): Promise<WebpackCLICommand | undefined> {
    const alreadyLoaded = this.program.commands.find(
      (command) =>
        command.name() === commandOptions.name.split(" ")[0] ||
        command.aliases().includes(commandOptions.alias as string),
    );

    if (alreadyLoaded) {
      return;
    }

    const command = this.program.command(commandOptions.name, {
      hidden: commandOptions.hidden,
      isDefault: commandOptions.isDefault,
    }) as WebpackCLICommand;

    if (commandOptions.description) {
      command.description(commandOptions.description, commandOptions.argsDescription!);
    }

    if (commandOptions.usage) {
      command.usage(commandOptions.usage);
    }

    if (Array.isArray(commandOptions.alias)) {
      command.aliases(commandOptions.alias);
    } else {
      command.alias(commandOptions.alias);
    }

    command.pkg = commandOptions.pkg || "webpack-cli";

    const { forHelp } = this.program;

    let allDependenciesInstalled = true;

    if (commandOptions.dependencies && commandOptions.dependencies.length > 0) {
      for (const dependency of commandOptions.dependencies) {
        const isPkgExist = this.checkPackageExists(dependency);

        if (isPkgExist) {
          continue;
        } else if (!isPkgExist && forHelp) {
          allDependenciesInstalled = false;
          continue;
        }

        let skipInstallation = false;

        // Allow to use `./path/to/webpack.js` outside `node_modules`
        if (dependency === WEBPACK_PACKAGE && WEBPACK_PACKAGE_IS_CUSTOM) {
          skipInstallation = true;
        }

        // Allow to use `./path/to/webpack-dev-server.js` outside `node_modules`
        if (dependency === WEBPACK_DEV_SERVER_PACKAGE && WEBPACK_DEV_SERVER_PACKAGE_IS_CUSTOM) {
          skipInstallation = true;
        }

        if (skipInstallation) {
          continue;
        }

        await this.doInstall(dependency, {
          preMessage: () => {
            this.logger.error(
              `For using '${this.colors.green(
                commandOptions.name.split(" ")[0],
              )}' command you need to install: '${this.colors.green(dependency)}' package.`,
            );
          },
        });
      }
    }

    if (options) {
      if (typeof options === "function") {
        if (forHelp && !allDependenciesInstalled && commandOptions.dependencies) {
          command.description(
            `${
              commandOptions.description
            } To see all available options you need to install ${commandOptions.dependencies
              .map((dependency) => `'${dependency}'`)
              .join(", ")}.`,
          );
          options = [];
        } else {
          options = await options();
        }
      }

      for (const option of options) {
        this.makeOption(command, option);
      }
    }

    command.action(action);

    return command;
  }

  makeOption(command: WebpackCLICommand, option: WebpackCLIBuiltInOption) {
    let mainOption: WebpackCLIMainOption;
    let negativeOption;
    const flagsWithAlias = ["devtool", "output-path", "target", "watch", "extends"];

    if (flagsWithAlias.includes(option.name)) {
      [option.alias] = option.name;
    }

    if (option.configs) {
      let needNegativeOption = false;
      let negatedDescription;
      const mainOptionType: WebpackCLIMainOption["type"] = new Set();

      for (const config of option.configs) {
        switch (config.type) {
          case "reset":
            mainOptionType.add(Boolean);
            break;
          case "boolean":
            if (!needNegativeOption) {
              needNegativeOption = true;
              negatedDescription = config.negatedDescription;
            }

            mainOptionType.add(Boolean);
            break;
          case "number":
            mainOptionType.add(Number);
            break;
          case "string":
          case "path":
          case "RegExp":
            mainOptionType.add(String);
            break;
          case "enum": {
            let hasFalseEnum = false;

            for (const value of config.values || []) {
              switch (typeof value) {
                case "string":
                  mainOptionType.add(String);
                  break;
                case "number":
                  mainOptionType.add(Number);
                  break;
                case "boolean":
                  if (!hasFalseEnum && value === false) {
                    hasFalseEnum = true;
                    break;
                  }

                  mainOptionType.add(Boolean);
                  break;
              }
            }

            if (!needNegativeOption) {
              needNegativeOption = hasFalseEnum;
              negatedDescription = config.negatedDescription;
            }
          }
        }
      }

      mainOption = {
        flags: option.alias ? `-${option.alias}, --${option.name}` : `--${option.name}`,
        valueName: option.valueName || "value",
        description: option.description || "",
        type: mainOptionType,
        multiple: option.multiple,
        defaultValue: option.defaultValue,
      };

      if (needNegativeOption) {
        negativeOption = {
          flags: `--no-${option.name}`,
          description:
            negatedDescription || option.negatedDescription || `Negative '${option.name}' option.`,
        };
      }
    } else {
      mainOption = {
        flags: option.alias ? `-${option.alias}, --${option.name}` : `--${option.name}`,
        valueName: option.valueName || "value",
        description: option.description || "",
        type: option.type
          ? new Set(Array.isArray(option.type) ? option.type : [option.type])
          : new Set([Boolean]),
        multiple: option.multiple,
        defaultValue: option.defaultValue,
      };

      if (option.negative) {
        negativeOption = {
          flags: `--no-${option.name}`,
          description: option.negatedDescription || `Negative '${option.name}' option.`,
        };
      }
    }

    if (mainOption.type.size > 1 && mainOption.type.has(Boolean)) {
      mainOption.flags = `${mainOption.flags} [${mainOption.valueName || "value"}${
        mainOption.multiple ? "..." : ""
      }]`;
    } else if (mainOption.type.size > 0 && !mainOption.type.has(Boolean)) {
      mainOption.flags = `${mainOption.flags} <${mainOption.valueName || "value"}${
        mainOption.multiple ? "..." : ""
      }>`;
    }

    if (mainOption.type.size === 1) {
      if (mainOption.type.has(Number)) {
        let skipDefault = true;

        const optionForCommand: WebpackCLICommandOption = new Option(
          mainOption.flags,
          mainOption.description,
        )
          .argParser((value: string, prev = []) => {
            if (mainOption.defaultValue && mainOption.multiple && skipDefault) {
              prev = [];
              skipDefault = false;
            }

            return mainOption.multiple ? [...prev, Number(value)] : Number(value);
          })
          .default(mainOption.defaultValue);

        optionForCommand.helpLevel = option.helpLevel;

        command.addOption(optionForCommand);
      } else if (mainOption.type.has(String)) {
        let skipDefault = true;

        const optionForCommand: WebpackCLICommandOption = new Option(
          mainOption.flags,
          mainOption.description,
        )
          .argParser((value: string, prev = []) => {
            if (mainOption.defaultValue && mainOption.multiple && skipDefault) {
              prev = [];
              skipDefault = false;
            }

            return mainOption.multiple ? [...prev, value] : value;
          })
          .default(mainOption.defaultValue);

        optionForCommand.helpLevel = option.helpLevel;

        command.addOption(optionForCommand);
      } else if (mainOption.type.has(Boolean)) {
        const optionForCommand = new Option(mainOption.flags, mainOption.description).default(
          mainOption.defaultValue,
        );

        optionForCommand.helpLevel = option.helpLevel;

        command.addOption(optionForCommand);
      } else {
        const optionForCommand = new Option(mainOption.flags, mainOption.description)
          .argParser([...mainOption.type][0])
          .default(mainOption.defaultValue);

        optionForCommand.helpLevel = option.helpLevel;

        command.addOption(optionForCommand);
      }
    } else if (mainOption.type.size > 1) {
      let skipDefault = true;

      const optionForCommand = new Option(
        mainOption.flags,
        mainOption.description,
        mainOption.defaultValue,
      )
        .argParser((value: string, prev = []) => {
          if (mainOption.defaultValue && mainOption.multiple && skipDefault) {
            prev = [];
            skipDefault = false;
          }

          if (mainOption.type.has(Number)) {
            const numberValue = Number(value);

            if (!Number.isNaN(numberValue)) {
              return mainOption.multiple ? [...prev, numberValue] : numberValue;
            }
          }

          if (mainOption.type.has(String)) {
            return mainOption.multiple ? [...prev, value] : value;
          }

          return value;
        })
        .default(mainOption.defaultValue);

      optionForCommand.helpLevel = option.helpLevel;

      command.addOption(optionForCommand);
    } else if (mainOption.type.size === 0 && negativeOption) {
      const optionForCommand = new Option(mainOption.flags, mainOption.description);

      // Hide stub option
      optionForCommand.hideHelp();
      optionForCommand.helpLevel = option.helpLevel;

      command.addOption(optionForCommand);
    }

    if (negativeOption) {
      const optionForCommand = new Option(negativeOption.flags, negativeOption.description);

      optionForCommand.helpLevel = option.helpLevel;

      command.addOption(optionForCommand);
    }
  }

  getBuiltInOptions(): WebpackCLIBuiltInOption[] {
    if (this.builtInOptionsCache) {
      return this.builtInOptionsCache;
    }

    const builtInFlags: WebpackCLIBuiltInFlag[] = [
      // For configs
      {
        name: "config",
        alias: "c",
        configs: [
          {
            type: "string",
          },
        ],
        multiple: true,
        valueName: "pathToConfigFile",
        description:
          'Provide path to one or more webpack configuration files to process, e.g. "./webpack.config.js".',
        helpLevel: "minimum",
      },
      {
        name: "config-name",
        configs: [
          {
            type: "string",
          },
        ],
        multiple: true,
        valueName: "name",
        description:
          "Name(s) of particular configuration(s) to use if configuration file exports an array of multiple configurations.",
        helpLevel: "minimum",
      },
      {
        name: "merge",
        alias: "m",
        configs: [
          {
            type: "enum",
            values: [true],
          },
        ],
        description: "Merge two or more configurations using 'webpack-merge'.",
        helpLevel: "minimum",
      },
      {
        name: "disable-interpret",
        configs: [
          {
            type: "enum",
            values: [true],
          },
        ],
        description: "Disable interpret for loading the config file.",
        helpLevel: "minimum",
      },
      // Complex configs
      {
        name: "env",
        type: (
          value: string,
          previous: Record<string, BasicPrimitive | object> = {},
        ): Record<string, BasicPrimitive | object> => {
          // This ensures we're only splitting by the first `=`
          const [allKeys, val] = value.split(/[=](.+)/, 2);
          const splitKeys = allKeys.split(/\.(?!$)/);

          let prevRef = previous;

          for (let [index, someKey] of splitKeys.entries()) {
            // https://github.com/webpack/webpack-cli/issues/3284
            if (someKey.endsWith("=")) {
              // remove '=' from key
              someKey = someKey.slice(0, -1);
              // @ts-expect-error we explicitly want to set it to undefined
              prevRef[someKey] = undefined;
              continue;
            }

            if (!prevRef[someKey]) {
              prevRef[someKey] = {};
            }

            if (typeof prevRef[someKey] === "string") {
              prevRef[someKey] = {};
            }

            if (index === splitKeys.length - 1) {
              prevRef[someKey] = typeof val === "string" ? val : true;
            }

            prevRef = prevRef[someKey] as Record<string, string | object | boolean>;
          }

          return previous;
        },
        multiple: true,
        description:
          'Environment variables passed to the configuration when it is a function, e.g. "myvar" or "myvar=myval".',
        helpLevel: "minimum",
      },
      {
        name: "node-env",
        configs: [
          {
            type: "string",
          },
        ],
        multiple: false,
        description:
          "Sets process.env.NODE_ENV to the specified value for access within the configuration.(Deprecated: Use '--config-node-env' instead)",
        helpLevel: "minimum",
      },
      {
        name: "config-node-env",
        configs: [
          {
            type: "string",
          },
        ],
        multiple: false,
        description:
          "Sets process.env.NODE_ENV to the specified value for access within the configuration.",
        helpLevel: "minimum",
      },

      // Adding more plugins
      {
        name: "analyze",
        configs: [
          {
            type: "enum",
            values: [true],
          },
        ],
        multiple: false,
        description: "It invokes webpack-bundle-analyzer plugin to get bundle information.",
        helpLevel: "minimum",
      },
      {
        name: "progress",
        configs: [
          {
            type: "string",
          },
          {
            type: "enum",
            values: [true],
          },
        ],
        description: "Print compilation progress during build.",
        helpLevel: "minimum",
      },

      // Output options
      {
        name: "json",
        configs: [
          {
            type: "string",
          },
          {
            type: "enum",
            values: [true],
          },
        ],
        alias: "j",
        valueName: "pathToJsonFile",
        description: "Prints result as JSON or store it in a file.",
        helpLevel: "minimum",
      },
      {
        name: "fail-on-warnings",
        configs: [
          {
            type: "enum",
            values: [true],
          },
        ],
        description: "Stop webpack-cli process with non-zero exit code on warnings from webpack.",
        helpLevel: "minimum",
      },
    ];

    // Options from webpack core to be included in the minimum help output
    const minimumHelpFlags = [
      "mode",
      "watch",
      "watch-options-stdin",
      "stats",
      "devtool",
      "entry",
      "target",
      "name",
      "output-path",
      "extends",
    ];

    // Extract all the flags being exported from core.
    // A list of cli flags generated by core can be found here https://github.com/webpack/webpack/blob/main/test/__snapshots__/Cli.basictest.js.snap
    const options = [
      ...builtInFlags,
      ...Object.entries(this.webpack.cli.getArguments()).map<WebpackCLIBuiltInOption>(
        ([name, meta]) => ({
          ...meta,
          name,
          description: meta.description,
          group: "core",
          helpLevel: minimumHelpFlags.includes(name) ? "minimum" : "verbose",
        }),
      ),
    ];

    this.builtInOptionsCache = options;

    return options;
  }

  async loadWebpack(handleError = true) {
    return this.tryRequireThenImport<typeof webpack>(WEBPACK_PACKAGE, handleError);
  }

  async run(args: Parameters<WebpackCLICommand["parseOptions"]>[0], parseOptions: ParseOptions) {
    // Default `--color` and `--no-color` options
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const cli: IWebpackCLI = this;

    // Built-in internal commands
    const buildCommandOptions = {
      name: "build [entries...]",
      alias: ["bundle", "b"],
      description: "Run webpack (default command, can be omitted).",
      usage: "[entries...] [options]",
      dependencies: [WEBPACK_PACKAGE],
    };
    const watchCommandOptions = {
      name: "watch [entries...]",
      alias: "w",
      description: "Run webpack and watch for files changes.",
      usage: "[entries...] [options]",
      dependencies: [WEBPACK_PACKAGE],
    };
    const versionCommandOptions = {
      name: "version",
      alias: "v",
      usage: "[options]",
      description:
        "Output the version number of 'webpack', 'webpack-cli' and 'webpack-dev-server' and commands.",
    };
    const helpCommandOptions = {
      name: "help [command] [option]",
      alias: "h",
      description: "Display help for commands and options.",
    };
    // Built-in external commands
    const externalBuiltInCommandsInfo: WebpackCLIExternalCommandInfo[] = [
      {
        name: "serve [entries...]",
        alias: ["server", "s"],
        pkg: "@webpack-cli/serve",
      },
      {
        name: "info",
        alias: "i",
        pkg: "@webpack-cli/info",
      },
      {
        name: "configtest [config-path]",
        alias: "t",
        pkg: "@webpack-cli/configtest",
      },
    ];

    const knownCommands = [
      buildCommandOptions,
      watchCommandOptions,
      versionCommandOptions,
      helpCommandOptions,
      ...externalBuiltInCommandsInfo,
    ];
    const getCommandName = (name: string) => name.split(" ")[0];
    const isKnownCommand = (name: string) =>
      knownCommands.find(
        (command) =>
          getCommandName(command.name) === name ||
          (Array.isArray(command.alias) ? command.alias.includes(name) : command.alias === name),
      );
    const isCommand = (input: string, commandOptions: WebpackCLIOptions) => {
      const longName = getCommandName(commandOptions.name);

      if (input === longName) {
        return true;
      }

      if (commandOptions.alias) {
        if (Array.isArray(commandOptions.alias)) {
          return commandOptions.alias.includes(input);
        }
        return commandOptions.alias === input;
      }

      return false;
    };
    const findCommandByName = (name: string) =>
      this.program.commands.find(
        (command) => name === command.name() || command.aliases().includes(name),
      );
    const isOption = (value: string): boolean => value.startsWith("-");
    const isGlobalOption = (value: string) =>
      value === "--color" ||
      value === "--no-color" ||
      value === "-v" ||
      value === "--version" ||
      value === "-h" ||
      value === "--help";

    const loadCommandByName = async (
      commandName: WebpackCLIExternalCommandInfo["name"],
      allowToInstall = false,
    ) => {
      const isBuildCommandUsed = isCommand(commandName, buildCommandOptions);
      const isWatchCommandUsed = isCommand(commandName, watchCommandOptions);

      if (isBuildCommandUsed || isWatchCommandUsed) {
        await this.makeCommand(
          isBuildCommandUsed ? buildCommandOptions : watchCommandOptions,
          async () => {
            this.webpack = await this.loadWebpack();

            return this.getBuiltInOptions();
          },
          async (entries, options) => {
            if (entries.length > 0) {
              options.entry = [...entries, ...(options.entry || [])];
            }

            await this.runWebpack(options, isWatchCommandUsed);
          },
        );
      } else if (isCommand(commandName, helpCommandOptions)) {
        this.makeCommand(helpCommandOptions, [], () => {
          // Stub for the `help` command
        });
      } else if (isCommand(commandName, versionCommandOptions)) {
        // Stub for the `version` command
        this.makeCommand(
          versionCommandOptions,
          this.getInfoOptions(),
          async (options: { output: string; additionalPackage: string[] }) => {
            const info = await cli.getInfoOutput(options);

            cli.logger.raw(info);
          },
        );
      } else {
        const builtInExternalCommandInfo = externalBuiltInCommandsInfo.find(
          (externalBuiltInCommandInfo) =>
            getCommandName(externalBuiltInCommandInfo.name) === commandName ||
            (Array.isArray(externalBuiltInCommandInfo.alias)
              ? externalBuiltInCommandInfo.alias.includes(commandName)
              : externalBuiltInCommandInfo.alias === commandName),
        );

        let pkg: string;

        if (builtInExternalCommandInfo) {
          ({ pkg } = builtInExternalCommandInfo);
        } else {
          pkg = commandName;
        }

        if (pkg !== "webpack-cli" && !this.checkPackageExists(pkg)) {
          if (!allowToInstall) {
            return;
          }

          pkg = await this.doInstall(pkg, {
            preMessage: () => {
              this.logger.error(
                `For using this command you need to install: '${this.colors.green(pkg)}' package.`,
              );
            },
          });
        }

        let loadedCommand;

        try {
          loadedCommand = await this.tryRequireThenImport<Instantiable<() => void>>(pkg, false);
        } catch {
          // Ignore, command is not installed

          return;
        }

        let command;

        try {
          // eslint-disable-next-line new-cap
          command = new loadedCommand();

          await command.apply(this);
        } catch (error) {
          this.logger.error(`Unable to load '${pkg}' command`);
          this.logger.error(error);
          process.exit(2);
        }
      }
    };

    // Register own exit
    this.program.exitOverride(async (error) => {
      if (error.exitCode === 0) {
        process.exit(0);
      }

      if (error.code === "executeSubCommandAsync") {
        process.exit(2);
      }

      if (error.code === "commander.help") {
        process.exit(0);
      }

      if (error.code === "commander.unknownOption") {
        let name = error.message.match(/'(.+)'/) as string | null;

        if (name) {
          name = name[1].slice(2);

          if (name.includes("=")) {
            [name] = name.split("=");
          }

          const { operands } = this.program.parseOptions(this.program.args);
          const operand =
            typeof operands[0] !== "undefined"
              ? operands[0]
              : getCommandName(buildCommandOptions.name);

          if (operand) {
            const command = findCommandByName(operand);

            if (!command) {
              this.logger.error(`Can't find and load command '${operand}'`);
              this.logger.error("Run 'webpack --help' to see available commands and options");
              process.exit(2);
            }

            const levenshtein = require("fastest-levenshtein");

            for (const option of (command as WebpackCLICommand).options) {
              if (!option.hidden && levenshtein.distance(name, option.long?.slice(2)) < 3) {
                this.logger.error(`Did you mean '--${option.name()}'?`);
              }
            }
          }
        }
      }

      // Codes:
      // - commander.unknownCommand
      // - commander.missingArgument
      // - commander.missingMandatoryOptionValue
      // - commander.optionMissingArgument

      this.logger.error("Run 'webpack --help' to see available commands and options");
      process.exit(2);
    });

    this.program.option("--color", "Enable colors on console.");
    this.program.on("option:color", function color(this: WebpackCLICommand) {
      const { color } = this.opts();

      cli.isColorSupportChanged = color;
      cli.colors = cli.createColors(color);
    });
    this.program.option("--no-color", "Disable colors on console.");
    this.program.on("option:no-color", function noColor(this: WebpackCLICommand) {
      const { color } = this.opts();

      cli.isColorSupportChanged = color;
      cli.colors = cli.createColors(color);
    });

    this.program.option(
      "-v, --version",
      "Output the version number of 'webpack', 'webpack-cli' and 'webpack-dev-server' and commands.",
    );

    // webpack-cli has it's own logic for showing suggestions
    this.program.showSuggestionAfterError(false);

    const outputHelp = async (
      options: string[],
      isVerbose: boolean,
      isHelpCommandSyntax: boolean,
      program: WebpackCLICommand,
    ) => {
      const { bold } = this.colors;
      const outputIncorrectUsageOfHelp = () => {
        this.logger.error("Incorrect use of help");
        this.logger.error(
          "Please use: 'webpack help [command] [option]' | 'webpack [command] --help'",
        );
        this.logger.error("Run 'webpack --help' to see available commands and options");
        process.exit(2);
      };

      const isGlobalHelp = options.length === 0;
      const isCommandHelp = options.length === 1 && !isOption(options[0]);

      if (isGlobalHelp || isCommandHelp) {
        program.configureHelp({
          sortSubcommands: true,
          // Support multiple aliases
          commandUsage: (command: WebpackCLICommand) => {
            let parentCmdNames = "";

            for (let parentCmd = command.parent; parentCmd; parentCmd = parentCmd.parent) {
              parentCmdNames = `${parentCmd.name()} ${parentCmdNames}`;
            }

            if (isGlobalHelp) {
              return `${parentCmdNames}${command.usage()}\n${bold(
                "Alternative usage to run commands:",
              )} ${parentCmdNames}[command] [options]`;
            }

            return `${parentCmdNames}${command.name()}|${command
              .aliases()
              .join("|")} ${command.usage()}`;
          },
          // Support multiple aliases
          subcommandTerm: (command: WebpackCLICommand) => {
            const humanReadableArgumentName = (argument: WebpackCLICommandOption) => {
              const nameOutput = argument.name() + (argument.variadic ? "..." : "");

              return argument.required ? `<${nameOutput}>` : `[${nameOutput}]`;
            };
            const args = command._args
              .map((arg: WebpackCLICommandOption) => humanReadableArgumentName(arg))
              .join(" ");

            return `${command.name()}|${command.aliases().join("|")}${args ? ` ${args}` : ""}${
              command.options.length > 0 ? " [options]" : ""
            }`;
          },
          visibleOptions: function visibleOptions(
            command: WebpackCLICommand,
          ): WebpackCLICommandOption[] {
            return command.options.filter((option: WebpackCLICommandOption) => {
              if (option.hidden) {
                return false;
              }

              // Hide `--watch` option when developer use `webpack watch --help`
              if (
                (options[0] === "w" || options[0] === "watch") &&
                (option.name() === "watch" || option.name() === "no-watch")
              ) {
                return false;
              }

              switch (option.helpLevel) {
                case "verbose":
                  return isVerbose;
                case "minimum":
                default:
                  return true;
              }
            });
          },
          padWidth(command: WebpackCLICommand, helper: Help) {
            return Math.max(
              helper.longestArgumentTermLength(command, helper),
              helper.longestOptionTermLength(command, helper),
              // For global options
              helper.longestOptionTermLength(program, helper),
              helper.longestSubcommandTermLength(isGlobalHelp ? program : command, helper),
            );
          },
          formatHelp: (command: WebpackCLICommand, helper: Help) => {
            const termWidth = helper.padWidth(command, helper);
            const helpWidth =
              helper.helpWidth || (process.env.WEBPACK_CLI_HELP_WIDTH as unknown as number) || 80;
            const itemIndentWidth = 2;
            const itemSeparatorWidth = 2; // between term and description

            const formatItem = (term: string, description: string) => {
              if (description) {
                const fullText = `${term.padEnd(termWidth + itemSeparatorWidth)}${description}`;

                return helper.wrap(
                  fullText,
                  helpWidth - itemIndentWidth,
                  termWidth + itemSeparatorWidth,
                );
              }

              return term;
            };

            const formatList = (textArray: string[]) =>
              textArray.join("\n").replaceAll(/^/gm, " ".repeat(itemIndentWidth));

            // Usage
            let output = [`${bold("Usage:")} ${helper.commandUsage(command)}`, ""];

            // Description
            const commandDescription = isGlobalHelp
              ? "The build tool for modern web applications."
              : helper.commandDescription(command);

            if (commandDescription.length > 0) {
              output = [...output, commandDescription, ""];
            }

            // Arguments
            const argumentList = helper
              .visibleArguments(command)
              .map((argument) => formatItem(argument.name(), argument.description));

            if (argumentList.length > 0) {
              output = [...output, bold("Arguments:"), formatList(argumentList), ""];
            }

            // Options
            const optionList = helper
              .visibleOptions(command)
              .map((option) =>
                formatItem(helper.optionTerm(option), helper.optionDescription(option)),
              );

            if (optionList.length > 0) {
              output = [...output, bold("Options:"), formatList(optionList), ""];
            }

            // Global options
            const globalOptionList = program.options.map((option: WebpackCLICommandOption) =>
              formatItem(helper.optionTerm(option), helper.optionDescription(option)),
            );

            if (globalOptionList.length > 0) {
              output = [...output, bold("Global options:"), formatList(globalOptionList), ""];
            }

            // Commands
            const commandList = helper
              .visibleCommands(isGlobalHelp ? program : command)
              .map((command) =>
                formatItem(helper.subcommandTerm(command), helper.subcommandDescription(command)),
              );

            if (commandList.length > 0) {
              output = [...output, bold("Commands:"), formatList(commandList), ""];
            }

            return output.join("\n");
          },
        });

        if (isGlobalHelp) {
          await Promise.all(
            knownCommands.map((knownCommand) =>
              loadCommandByName(getCommandName(knownCommand.name)),
            ),
          );

          const buildCommand = findCommandByName(getCommandName(buildCommandOptions.name));

          if (buildCommand) {
            this.logger.raw(buildCommand.helpInformation());
          }
        } else {
          const [name] = options;

          await loadCommandByName(name);

          const command = findCommandByName(name);

          if (!command) {
            const builtInCommandUsed = externalBuiltInCommandsInfo.find(
              (command) => command.name.includes(name) || name === command.alias,
            );
            if (typeof builtInCommandUsed !== "undefined") {
              this.logger.error(
                `For using '${name}' command you need to install '${builtInCommandUsed.pkg}' package.`,
              );
            } else {
              this.logger.error(`Can't find and load command '${name}'`);
              this.logger.error("Run 'webpack --help' to see available commands and options.");
            }
            process.exit(2);
          }

          this.logger.raw(command.helpInformation());
        }
      } else if (isHelpCommandSyntax) {
        let isCommandSpecified = false;
        let commandName = getCommandName(buildCommandOptions.name);
        let optionName = "";

        if (options.length === 1) {
          [optionName] = options;
        } else if (options.length === 2) {
          isCommandSpecified = true;
          [commandName, optionName] = options;

          if (isOption(commandName)) {
            outputIncorrectUsageOfHelp();
          }
        } else {
          outputIncorrectUsageOfHelp();
        }

        await loadCommandByName(commandName);

        const command = isGlobalOption(optionName) ? program : findCommandByName(commandName);

        if (!command) {
          this.logger.error(`Can't find and load command '${commandName}'`);
          this.logger.error("Run 'webpack --help' to see available commands and options");
          process.exit(2);
        }

        const option = (command as WebpackCLICommand).options.find(
          (option) => option.short === optionName || option.long === optionName,
        );

        if (!option) {
          this.logger.error(`Unknown option '${optionName}'`);
          this.logger.error("Run 'webpack --help' to see available commands and options");
          process.exit(2);
        }

        const nameOutput =
          option.flags.replace(/^.+[[<]/, "").replace(/(\.\.\.)?[\]>].*$/, "") +
          (option.variadic === true ? "..." : "");
        const value = option.required
          ? `<${nameOutput}>`
          : option.optional
            ? `[${nameOutput}]`
            : "";

        this.logger.raw(
          `${bold("Usage")}: webpack${isCommandSpecified ? ` ${commandName}` : ""} ${option.long}${
            value ? ` ${value}` : ""
          }`,
        );

        if (option.short) {
          this.logger.raw(
            `${bold("Short:")} webpack${isCommandSpecified ? ` ${commandName}` : ""} ${
              option.short
            }${value ? ` ${value}` : ""}`,
          );
        }

        if (option.description) {
          this.logger.raw(`${bold("Description:")} ${option.description}`);
        }

        if (!option.negate && option.defaultValue) {
          this.logger.raw(`${bold("Default value:")} ${JSON.stringify(option.defaultValue)}`);
        }

        const flag = this.getBuiltInOptions().find((flag) => option.long === `--${flag.name}`);

        if (flag?.configs) {
          const possibleValues = flag.configs.reduce((accumulator, currentValue) => {
            if (currentValue.values) {
              return [...accumulator, ...currentValue.values];
            }

            return accumulator;
          }, [] as EnumValue[]);

          if (possibleValues.length > 0) {
            // Convert the possible values to a union type string
            // ['mode', 'development', 'production'] => "'mode' | 'development' | 'production'"
            // [false, 'eval'] => "false | 'eval'"
            const possibleValuesUnionTypeString = possibleValues
              .map((value) => (typeof value === "string" ? `'${value}'` : value))
              .join(" | ");

            this.logger.raw(`${bold("Possible values:")} ${possibleValuesUnionTypeString}`);
          }
        }

        this.logger.raw("");

        // TODO implement this after refactor cli arguments
        // logger.raw('Documentation: https://webpack.js.org/option/name/');
      } else {
        outputIncorrectUsageOfHelp();
      }

      this.logger.raw(
        "To see list of all supported commands and options run 'webpack --help=verbose'.\n",
      );
      this.logger.raw(`${bold("Webpack documentation:")} https://webpack.js.org/.`);
      this.logger.raw(`${bold("CLI documentation:")} https://webpack.js.org/api/cli/.`);
      this.logger.raw(`${bold("Made with ♥ by the webpack team")}.`);
      process.exit(0);
    };
    this.program.helpOption(false);
    // Suppress the default help command
    this.program.helpCommand(false);
    this.program.option("-h, --help [verbose]", "Display help for commands and options.");

    let isInternalActionCalled = false;

    // Default action
    this.program.usage("[options]");
    this.program.allowUnknownOption(true);

    // Basic command for lazy loading other commands
    this.program.action(async (options, program: WebpackCLICommand) => {
      if (!isInternalActionCalled) {
        isInternalActionCalled = true;
      } else {
        this.logger.error("No commands found to run");
        process.exit(2);
      }

      // Command and options
      const { operands, unknown } = this.program.parseOptions(program.args);
      const defaultCommandToRun = getCommandName(buildCommandOptions.name);
      const hasOperand = typeof operands[0] !== "undefined";
      const operand = hasOperand ? operands[0] : defaultCommandToRun;
      const isHelpOption = typeof options.help !== "undefined";
      const isHelpCommandSyntax = isCommand(operand, helpCommandOptions);

      if (isHelpOption || isHelpCommandSyntax) {
        let isVerbose = false;

        if (isHelpOption && typeof options.help === "string") {
          if (options.help !== "verbose") {
            this.logger.error("Unknown value for '--help' option, please use '--help=verbose'");
            process.exit(2);
          }

          isVerbose = true;
        }

        this.program.forHelp = true;

        const optionsForHelp = [
          ...(isHelpOption && hasOperand ? [operand] : []),
          ...operands.slice(1),
          ...unknown,
          ...(isHelpCommandSyntax && typeof options.color !== "undefined"
            ? [options.color ? "--color" : "--no-color"]
            : []),
          ...(isHelpCommandSyntax && typeof options.version !== "undefined" ? ["--version"] : []),
        ];

        await outputHelp(optionsForHelp, isVerbose, isHelpCommandSyntax, program);
      }

      const isVersionOption = typeof options.version !== "undefined";

      if (isVersionOption) {
        const info = await this.getInfoOutput({ output: "", additionalPackage: [] });
        this.logger.raw(info);
        process.exit(0);
      }

      let commandToRun = operand;
      let commandOperands = operands.slice(1);

      if (isKnownCommand(commandToRun)) {
        await loadCommandByName(commandToRun, true);
      } else {
        const isEntrySyntax = fs.existsSync(operand);

        if (isEntrySyntax) {
          commandToRun = defaultCommandToRun;
          commandOperands = operands;

          await loadCommandByName(commandToRun);
        } else {
          this.logger.error(`Unknown command or entry '${operand}'`);

          const levenshtein = require("fastest-levenshtein");

          const found = knownCommands.find(
            (commandOptions) =>
              levenshtein.distance(operand, getCommandName(commandOptions.name)) < 3,
          );

          if (found) {
            this.logger.error(
              `Did you mean '${getCommandName(found.name)}' (alias '${
                Array.isArray(found.alias) ? found.alias.join(", ") : found.alias
              }')?`,
            );
          }

          this.logger.error("Run 'webpack --help' to see available commands and options");
          process.exit(2);
        }
      }

      await this.program.parseAsync([commandToRun, ...commandOperands, ...unknown], {
        from: "user",
      });
    });

    await this.program.parseAsync(args, parseOptions);
  }

  async loadConfig(options: Partial<WebpackDevServerOptions>) {
    const disableInterpret =
      typeof options.disableInterpret !== "undefined" && options.disableInterpret;

    const interpret = require("interpret");

    const loadConfigByPath = async (
      configPath: string,
      argv: Argv = {},
    ): Promise<{ options: WebpackConfiguration | WebpackConfiguration[]; path: string }> => {
      const ext = path.extname(configPath).toLowerCase();
      let interpreted = Object.keys(interpret.jsVariants).find((variant) => variant === ext);
      // Fallback `.cts` to `.ts`
      // TODO implement good `.mts` support after https://github.com/gulpjs/rechoir/issues/43
      // For ESM and `.mts` you need to use: 'NODE_OPTIONS="--loader ts-node/esm" webpack-cli --config ./webpack.config.mts'
      if (!interpreted && ext.endsWith(".cts")) {
        interpreted = interpret.jsVariants[".ts"];
      }

      if (interpreted && !disableInterpret) {
        const rechoir: Rechoir = require("rechoir");

        try {
          rechoir.prepare(interpret.extensions, configPath);
        } catch (error) {
          if ((error as RechoirError)?.failures) {
            this.logger.error(`Unable load '${configPath}'`);
            this.logger.error((error as RechoirError).message);
            for (const failure of (error as RechoirError).failures) {
              this.logger.error(failure.error.message);
            }
            this.logger.error("Please install one of them");
            process.exit(2);
          }

          this.logger.error(error);
          process.exit(2);
        }
      }

      let options: LoadableWebpackConfiguration | LoadableWebpackConfiguration[];

      type LoadConfigOption = PotentialPromise<WebpackConfiguration>;

      let moduleType: "unknown" | "commonjs" | "esm" = "unknown";

      switch (ext) {
        case ".cjs":
        case ".cts":
          moduleType = "commonjs";
          break;
        case ".mjs":
        case ".mts":
          moduleType = "esm";
          break;
      }

      try {
        options = await this.tryRequireThenImport<LoadConfigOption | LoadConfigOption[]>(
          configPath,
          false,
          moduleType,
        );
      } catch (error) {
        this.logger.error(`Failed to load '${configPath}' config`);

        if (this.isValidationError(error)) {
          this.logger.error(error.message);
        } else {
          this.logger.error(error);
        }

        process.exit(2);
      }

      if (!options) {
        this.logger.error(`Failed to load '${configPath}' config. Unable to find default export.`);
        process.exit(2);
      }

      if (Array.isArray(options)) {
        // reassign the value to assert type
        const optionsArray: LoadableWebpackConfiguration[] = options;
        await Promise.all(
          optionsArray.map(async (_, i) => {
            if (
              this.isPromise<WebpackConfiguration | CallableWebpackConfiguration>(
                optionsArray[i] as Promise<WebpackConfiguration | CallableWebpackConfiguration>,
              )
            ) {
              optionsArray[i] = await optionsArray[i];
            }
            // `Promise` may return `Function`
            if (this.isFunction(optionsArray[i])) {
              // when config is a function, pass the env from args to the config function
              optionsArray[i] = await optionsArray[i](argv.env, argv);
            }
          }),
        );
        options = optionsArray;
      } else {
        if (
          this.isPromise<LoadableWebpackConfiguration>(
            options as Promise<LoadableWebpackConfiguration>,
          )
        ) {
          options = await options;
        }

        // `Promise` may return `Function`
        if (this.isFunction(options)) {
          // when config is a function, pass the env from args to the config function
          options = await options(argv.env, argv);
        }
      }

      const isObject = (value: unknown): value is object =>
        typeof value === "object" && value !== null;

      if (!isObject(options) && !Array.isArray(options)) {
        this.logger.error(`Invalid configuration in '${configPath}'`);

        process.exit(2);
      }

      return {
        options: options as WebpackConfiguration | WebpackConfiguration[],
        path: configPath,
      };
    };

    const config: WebpackCLIConfig = {
      options: {},
      path: new WeakMap(),
    };

    if (options.config && options.config.length > 0) {
      const loadedConfigs = await Promise.all(
        options.config.map((configPath: string) =>
          loadConfigByPath(path.resolve(configPath), options.argv),
        ),
      );

      if (loadedConfigs.length === 1) {
        config.options = loadedConfigs[0].options;
        config.path.set(loadedConfigs[0].options, [loadedConfigs[0].path]);
      } else {
        config.options = [];
        for (const loadedConfig of loadedConfigs) {
          if (Array.isArray(loadedConfig.options)) {
            for (const item of loadedConfig.options) {
              (config.options as WebpackConfiguration[]).push(item);
              config.path.set(options, [loadedConfig.path]);
            }
          } else {
            (config.options as WebpackConfiguration[]).push(loadedConfig.options);
            config.path.set(loadedConfig.options, [loadedConfig.path]);
          }
        }
      }
    } else {
      // Prioritize popular extensions first to avoid unnecessary fs calls
      const extensions = new Set([
        ".js",
        ".mjs",
        ".cjs",
        ".ts",
        ".cts",
        ".mts",
        ...Object.keys(interpret.extensions),
      ]);
      // Order defines the priority, in decreasing order
      const defaultConfigFiles = new Set(
        ["webpack.config", ".webpack/webpack.config", ".webpack/webpackfile"].flatMap((filename) =>
          [...extensions].map((ext) => path.resolve(filename + ext)),
        ),
      );

      let foundDefaultConfigFile;

      for (const defaultConfigFile of defaultConfigFiles) {
        if (!fs.existsSync(defaultConfigFile)) {
          continue;
        }

        foundDefaultConfigFile = defaultConfigFile;
        break;
      }

      if (foundDefaultConfigFile) {
        const loadedConfig = await loadConfigByPath(foundDefaultConfigFile, options.argv);

        config.options = loadedConfig.options;

        if (Array.isArray(config.options)) {
          for (const item of config.options) {
            config.path.set(item, [loadedConfig.path]);
          }
        } else {
          config.path.set(loadedConfig.options, [loadedConfig.path]);
        }
      }
    }

    if (options.configName) {
      const notFoundConfigNames: string[] = [];

      config.options = options.configName.map((configName) => {
        let found;

        if (Array.isArray(config.options)) {
          found = config.options.find((options) => options.name === configName);
        } else {
          found = config.options.name === configName ? config.options : undefined;
        }

        if (!found) {
          notFoundConfigNames.push(configName);
        }

        return found;
      }) as WebpackConfiguration[];

      if (notFoundConfigNames.length > 0) {
        this.logger.error(
          notFoundConfigNames
            .map((configName) => `Configuration with the name "${configName}" was not found.`)
            .join(" "),
        );
        process.exit(2);
      }
    }

    const resolveExtends = async (
      config: WebpackConfiguration,
      configPaths: WebpackCLIConfig["path"],
      extendsPaths: string[],
    ): Promise<WebpackConfiguration> => {
      delete config.extends;

      const loadedConfigs = await Promise.all(
        extendsPaths.map((extendsPath) =>
          loadConfigByPath(path.resolve(extendsPath), options.argv),
        ),
      );

      const merge = await this.tryRequireThenImport<typeof webpackMerge>("webpack-merge");
      const loadedOptions = loadedConfigs.flatMap((config) => config.options);

      if (loadedOptions.length > 0) {
        const prevPaths = configPaths.get(config);
        const loadedPaths = loadedConfigs.flatMap((config) => config.path);

        if (prevPaths) {
          const intersection = loadedPaths.filter((element) => prevPaths.includes(element));

          if (intersection.length > 0) {
            this.logger.error("Recursive configuration detected, exiting.");
            process.exit(2);
          }
        }

        config = merge(
          ...(loadedOptions as [WebpackConfiguration, ...WebpackConfiguration[]]),
          config,
        );

        if (prevPaths) {
          configPaths.set(config, [...prevPaths, ...loadedPaths]);
        }
      }

      if (config.extends) {
        const extendsPaths = typeof config.extends === "string" ? [config.extends] : config.extends;

        config = await resolveExtends(config, configPaths, extendsPaths);
      }

      return config;
    };

    // The `extends` param in CLI gets priority over extends in config file
    if (options.extends && options.extends.length > 0) {
      const extendsPaths = options.extends;

      if (Array.isArray(config.options)) {
        config.options = await Promise.all(
          config.options.map((options) => resolveExtends(options, config.path, extendsPaths)),
        );
      } else {
        // load the config from the extends option
        config.options = await resolveExtends(config.options, config.path, extendsPaths);
      }
    }
    // if no extends option is passed, check if the config file has extends
    else if (Array.isArray(config.options) && config.options.some((options) => options.extends)) {
      config.options = await Promise.all(
        config.options.map((options) => {
          if (options.extends) {
            return resolveExtends(
              options,
              config.path,
              typeof options.extends === "string" ? [options.extends] : options.extends,
            );
          }
          return options;
        }),
      );
    } else if (!Array.isArray(config.options) && config.options.extends) {
      config.options = await resolveExtends(
        config.options,
        config.path,
        typeof config.options.extends === "string"
          ? [config.options.extends]
          : config.options.extends,
      );
    }

    if (options.merge) {
      const merge = await this.tryRequireThenImport<typeof webpackMerge>("webpack-merge");

      // we can only merge when there are multiple configurations
      // either by passing multiple configs by flags or passing a
      // single config exporting an array
      if (!Array.isArray(config.options) || config.options.length <= 1) {
        this.logger.error("At least two configurations are required for merge.");
        process.exit(2);
      }

      const mergedConfigPaths: string[] = [];

      config.options = config.options.reduce((accumulator: object, options) => {
        const configPath = config.path.get(options);
        const mergedOptions = merge(accumulator, options);

        if (configPath) {
          mergedConfigPaths.push(...configPath);
        }

        return mergedOptions;
      }, {});
      config.path.set(config.options, mergedConfigPaths);
    }

    return config;
  }

  async buildConfig(
    config: WebpackCLIConfig,
    options: Partial<WebpackDevServerOptions>,
  ): Promise<WebpackCLIConfig> {
    if (options.analyze && !this.checkPackageExists("webpack-bundle-analyzer")) {
      await this.doInstall("webpack-bundle-analyzer", {
        preMessage: () => {
          this.logger.error(
            `It looks like ${this.colors.yellow("webpack-bundle-analyzer")} is not installed.`,
          );
        },
      });

      this.logger.success(
        `${this.colors.yellow("webpack-bundle-analyzer")} was installed successfully.`,
      );
    }

    if (typeof options.progress === "string" && options.progress !== "profile") {
      this.logger.error(
        `'${options.progress}' is an invalid value for the --progress option. Only 'profile' is allowed.`,
      );
      process.exit(2);
    }

    const CLIPlugin =
      await this.tryRequireThenImport<Instantiable<CLIPluginClass, [CLIPluginOptions]>>(
        "./plugins/cli-plugin",
      );

    const internalBuildConfig = (item: WebpackConfiguration) => {
      const originalWatchValue = item.watch;

      // Apply options
      const args: Record<string, Argument> = this.getBuiltInOptions().reduce(
        (accumulator: Record<string, Argument>, flag) => {
          if (flag.group === "core") {
            accumulator[flag.name] = flag as unknown as Argument;
          }
          return accumulator;
        },
        {},
      );
      const values: ProcessedArguments = Object.keys(options).reduce(
        (accumulator: ProcessedArguments, name) => {
          if (name === "argv") {
            return accumulator;
          }

          const kebabName = this.toKebabCase(name);

          if (args[kebabName]) {
            accumulator[kebabName] = options[name as keyof typeof options as string];
          }

          return accumulator;
        },
        {},
      );

      if (Object.keys(values).length > 0) {
        const problems: Problem[] | null = this.webpack.cli.processArguments(args, item, values);

        if (problems) {
          const groupBy = <K extends keyof Problem & StringsKeys<Problem>>(xs: Problem[], key: K) =>
            xs.reduce((rv: Record<string, Problem[]>, problem: Problem) => {
              const path = problem[key];

              (rv[path] ||= []).push(problem);

              return rv;
            }, {});
          const problemsByPath = groupBy(problems, "path");

          for (const path in problemsByPath) {
            const problems = problemsByPath[path];

            for (const problem of problems) {
              this.logger.error(
                `${this.capitalizeFirstLetter(problem.type.replaceAll("-", " "))}${
                  problem.value ? ` '${problem.value}'` : ""
                } for the '--${problem.argument}' option${
                  problem.index ? ` by index '${problem.index}'` : ""
                }`,
              );

              if (problem.expected) {
                this.logger.error(`Expected: '${problem.expected}'`);
              }
            }
          }

          process.exit(2);
        }
      }

      // Output warnings
      if (!Object.isExtensible(item)) {
        return;
      }

      if (
        options.isWatchingLikeCommand &&
        options.argv?.env &&
        (typeof originalWatchValue !== "undefined" || typeof options.argv?.watch !== "undefined")
      ) {
        this.logger.warn(
          `No need to use the '${
            options.argv.env.WEBPACK_WATCH ? "watch" : "serve"
          }' command together with '{ watch: true | false }' or '--watch'/'--no-watch' configuration, it does not make sense.`,
        );

        if (options.argv.env.WEBPACK_SERVE) {
          item.watch = false;
        }
      }

      const isFileSystemCacheOptions = (
        config: WebpackConfiguration,
      ): config is FileSystemCacheOptions =>
        Boolean(config.cache) && (config as FileSystemCacheOptions).cache.type === "filesystem";

      // Setup default cache options
      if (isFileSystemCacheOptions(item) && Object.isExtensible(item.cache)) {
        const configPath = config.path.get(item);

        if (configPath) {
          if (!item.cache.buildDependencies) {
            item.cache.buildDependencies = {};
          }

          if (!item.cache.buildDependencies.defaultConfig) {
            item.cache.buildDependencies.defaultConfig = [];
          }

          if (Array.isArray(configPath)) {
            for (const oneOfConfigPath of configPath) {
              item.cache.buildDependencies.defaultConfig.push(oneOfConfigPath);
            }
          } else {
            item.cache.buildDependencies.defaultConfig.push(configPath);
          }
        }
      }

      // Respect `process.env.NODE_ENV`
      if (
        !item.mode &&
        process.env?.NODE_ENV &&
        (process.env.NODE_ENV === "development" ||
          process.env.NODE_ENV === "production" ||
          process.env.NODE_ENV === "none")
      ) {
        item.mode = process.env.NODE_ENV;
      }

      // Setup stats
      if (typeof item.stats === "undefined") {
        item.stats = { preset: "normal" };
      } else if (typeof item.stats === "boolean") {
        item.stats = item.stats ? { preset: "normal" } : { preset: "none" };
      } else if (typeof item.stats === "string") {
        item.stats = { preset: item.stats };
      }

      let colors;

      // From arguments
      if (typeof this.isColorSupportChanged !== "undefined") {
        colors = Boolean(this.isColorSupportChanged);
      }
      // From stats
      else if (typeof item.stats.colors !== "undefined") {
        colors = item.stats.colors;
      }
      // Default
      else {
        colors = Boolean(this.colors.isColorSupported);
      }

      if (Object.isExtensible(item.stats)) {
        item.stats.colors = colors;
      }

      // Apply CLI plugin
      if (!item.plugins) {
        item.plugins = [];
      }

      if (Object.isExtensible(item.plugins)) {
        item.plugins.unshift(
          new CLIPlugin({
            configPath: config.path.get(item),
            helpfulOutput: !options.json,
            progress: options.progress,
            analyze: options.analyze,
            isMultiCompiler: Array.isArray(config.options),
          }),
        );
      }
    };

    if (Array.isArray(config.options)) {
      for (const item of config.options) {
        internalBuildConfig(item);
      }
    } else {
      internalBuildConfig(config.options);
    }

    return config;
  }

  isValidationError(error: unknown): error is WebpackError {
    return (
      error instanceof this.webpack.ValidationError || (error as Error).name === "ValidationError"
    );
  }

  async createCompiler(
    options: Partial<WebpackDevServerOptions>,
    callback?: WebpackCallback,
  ): Promise<WebpackCompiler> {
    if (typeof options.configNodeEnv === "string") {
      process.env.NODE_ENV = options.configNodeEnv;
    } else if (typeof options.nodeEnv === "string") {
      process.env.NODE_ENV = options.nodeEnv;
    }

    let config = await this.loadConfig(options);
    config = await this.buildConfig(config, options);

    let compiler: WebpackCompiler;

    try {
      compiler = this.webpack(
        config.options,
        callback
          ? (error, stats) => {
              if (error && this.isValidationError(error)) {
                this.logger.error(error.message);
                process.exit(2);
              }

              callback(error as Error | undefined, stats);
            }
          : callback,
      )!;
    } catch (error) {
      if (this.isValidationError(error)) {
        this.logger.error(error.message);
      } else {
        this.logger.error(error);
      }

      process.exit(2);
    }

    return compiler;
  }

  needWatchStdin(compiler: Compiler | MultiCompiler): boolean {
    if (this.isMultipleCompiler(compiler)) {
      return Boolean(
        compiler.compilers.some((compiler: Compiler) => compiler.options.watchOptions?.stdin),
      );
    }

    return Boolean(compiler.options.watchOptions?.stdin);
  }

  async runWebpack(options: WebpackRunOptions, isWatchCommand: boolean): Promise<void> {
    let compiler: Compiler | MultiCompiler;
    let createStringifyChunked: typeof stringifyChunked;

    if (options.json) {
      const jsonExt = await this.tryRequireThenImport<JsonExt>("@discoveryjs/json-ext");

      createStringifyChunked = jsonExt.stringifyChunked;
    }

    const callback: WebpackCallback = (error, stats): void => {
      if (error) {
        this.logger.error(error);
        process.exit(2);
      }

      if (stats && (stats.hasErrors() || (options.failOnWarnings && stats.hasWarnings()))) {
        process.exitCode = 1;
      }

      if (!compiler || !stats) {
        return;
      }

      const statsOptions = this.isMultipleCompiler(compiler)
        ? ({
            children: compiler.compilers.map((compiler) =>
              compiler.options ? compiler.options.stats : undefined,
            ),
          } as MultiStatsOptions)
        : compiler.options
          ? (compiler.options.stats as StatsOptions)
          : undefined;

      if (options.json && createStringifyChunked) {
        const handleWriteError = (error: WebpackError) => {
          this.logger.error(error);
          process.exit(2);
        };

        if (options.json === true) {
          Readable.from(createStringifyChunked(stats.toJson(statsOptions as StatsOptions)))
            .on("error", handleWriteError)
            .pipe(process.stdout)
            .on("error", handleWriteError)
            .on("close", () => process.stdout.write("\n"));
        } else {
          Readable.from(createStringifyChunked(stats.toJson(statsOptions as StatsOptions)))
            .on("error", handleWriteError)
            .pipe(fs.createWriteStream(options.json))
            .on("error", handleWriteError)
            // Use stderr to logging
            .on("close", () => {
              process.stderr.write(
                `[webpack-cli] ${this.colors.green(
                  `stats are successfully stored as json to ${options.json}`,
                )}\n`,
              );
            });
        }
      } else {
        const printedStats = stats.toString(statsOptions as StatsOptions);

        // Avoid extra empty line when `stats: 'none'`
        if (printedStats) {
          this.logger.raw(printedStats);
        }
      }
    };

    const env =
      isWatchCommand || options.watch
        ? { WEBPACK_WATCH: true, ...options.env }
        : { WEBPACK_BUNDLE: true, WEBPACK_BUILD: true, ...options.env };

    options.argv = { ...options, env };

    if (isWatchCommand) {
      options.watch = true;
      options.isWatchingLikeCommand = true;
    }

    compiler = await this.createCompiler(options as WebpackDevServerOptions, callback);

    if (!compiler) {
      return;
    }

    const isWatch = (compiler: WebpackCompiler): boolean =>
      Boolean(
        this.isMultipleCompiler(compiler)
          ? compiler.compilers.some((compiler) => compiler.options.watch)
          : compiler.options.watch,
      );

    if (isWatch(compiler)) {
      let needForceShutdown = false;

      for (const signal of EXIT_SIGNALS) {
        // eslint-disable-next-line @typescript-eslint/no-loop-func
        const listener = () => {
          if (needForceShutdown) {
            process.exit(0);
          }

          this.logger.info(
            "Gracefully shutting down. To force exit, press ^C again. Please wait...",
          );

          needForceShutdown = true;

          compiler.close(() => {
            process.exit(0);
          });
        };

        process.on(signal, listener);
      }

      if (this.needWatchStdin(compiler)) {
        process.stdin.on("end", () => {
          process.exit(0);
        });
        process.stdin.resume();
      }
    }
  }
}

export default WebpackCLI;

// TODO remove me in the next major release and use `default` export
module.exports = WebpackCLI;
